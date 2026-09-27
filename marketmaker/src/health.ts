import { createServer, type Server } from "node:http";
import { LOCAL_RETAINED_ORDER_BUDGET } from "./admission.js";

export type MakerStatus = "starting" | "ok" | "degraded";

export interface HealthSnapshot {
  status: MakerStatus;
  ready: boolean;
  uptimeS: number;
  deploymentFingerprint: string;
  assets: string[];
  draining: boolean;
  managedOrders: number;
  tickRunning: boolean;
  lastTickStartedAt: string | null;
  lastTickCompletedAt: string | null;
  lastTickErrorAt: string | null;
  lastTickErrorCount: number;
  consecutiveFailedTicks: number;
  quoteAdmission: {
    state: "active" | "waiting-retention" | "backoff";
    retainedOrders: number;
    budget: number;
    retryAt: string | null;
  };
  /** Payout credits owed to THIS maker that it gave up moving after its
   *  per-record cap. Collectable by the operator, so a drain waits for this to
   *  reach zero. Reported as a count and leaving the status alone: a token that
   *  refuses to pay anyone cannot be made to, and holding at degraded forever
   *  would bury every other signal. */
  strandedCredits: number;
  /** Parked courtesy pushes owed to a counterparty. If that address can never
   *  receive, nothing an operator does clears one, so these are reported and
   *  never gate a drain; they are dismissed explicitly. */
  parkedCounterpartyCredits: number;
}

const iso = (value: number | null): string | null =>
  value === null ? null : new Date(value).toISOString();

/** Minimal operational state for the local health endpoint. Raw errors,
 *  addresses, balances, endpoints, order ids, and secrets never enter it. */
export class MakerHealth {
  private readonly startedAtMs: number;
  private runtimeVerified = false;
  private managedOrders = 0;
  private tickRunning = false;
  private lastTickStartedAtMs: number | null = null;
  private lastTickCompletedAtMs: number | null = null;
  private lastTickErrorAtMs: number | null = null;
  private lastTickErrorCount = 0;
  private consecutiveFailedTicks = 0;
  private retainedOrders = 0;
  private admissionRetryAt = 0;
  private strandedCredits = 0;
  private parkedCounterpartyCredits = 0;

  constructor(
    private readonly opts: {
      deploymentFingerprint: string;
      assets: string[];
      draining: boolean;
      staleAfterMs: number;
      now?: () => number;
    },
  ) {
    this.startedAtMs = this.now();
  }

  markRuntimeVerified(): void {
    this.runtimeVerified = true;
  }

  /** Records how many managed orders hold a credit this maker stopped trying
   *  to move. It is reported and leaves the status alone. */
  markStrandedCredits(count: number): void {
    this.strandedCredits = count;
  }

  /** Parked credits owed to a counterparty. Reported separately because they
   *  may be permanently unclearable and must never gate a drain. */
  markParkedCounterpartyCredits(count: number): void {
    this.parkedCounterpartyCredits = count;
  }

  markQuoteAdmission(retainedOrders: number, retryAt: number): void {
    this.retainedOrders = retainedOrders;
    this.admissionRetryAt = retryAt;
  }

  markTickStarted(managedOrders: number): void {
    this.managedOrders = managedOrders;
    this.tickRunning = true;
    this.lastTickStartedAtMs = this.now();
  }

  markTickCompleted(managedOrders: number, errorCount: number): void {
    const now = this.now();
    this.managedOrders = managedOrders;
    this.tickRunning = false;
    this.lastTickCompletedAtMs = now;
    this.lastTickErrorCount = errorCount;
    if (errorCount > 0) {
      this.lastTickErrorAtMs = now;
      this.consecutiveFailedTicks += 1;
    } else {
      this.consecutiveFailedTicks = 0;
    }
  }

  snapshot(): HealthSnapshot {
    const now = this.now();
    const ready = this.runtimeVerified && this.lastTickCompletedAtMs !== null;
    let status: MakerStatus = ready ? "ok" : "starting";
    const progressAt = this.tickRunning
      ? this.lastTickStartedAtMs
      : this.lastTickCompletedAtMs;
    if (
      (progressAt !== null && now - progressAt > this.opts.staleAfterMs) ||
      this.lastTickErrorCount > 0 || this.admissionRetryAt * 1000 > now
    ) {
      status = "degraded";
    }
    return {
      status,
      ready,
      uptimeS: Math.max(0, Math.floor((now - this.startedAtMs) / 1000)),
      deploymentFingerprint: this.opts.deploymentFingerprint,
      assets: [...this.opts.assets],
      draining: this.opts.draining,
      managedOrders: this.managedOrders,
      tickRunning: this.tickRunning,
      lastTickStartedAt: iso(this.lastTickStartedAtMs),
      lastTickCompletedAt: iso(this.lastTickCompletedAtMs),
      lastTickErrorAt: iso(this.lastTickErrorAtMs),
      lastTickErrorCount: this.lastTickErrorCount,
      consecutiveFailedTicks: this.consecutiveFailedTicks,
      quoteAdmission: {
        state: this.admissionRetryAt * 1000 > now ? "backoff"
          : this.retainedOrders >= LOCAL_RETAINED_ORDER_BUDGET ? "waiting-retention" : "active",
        retainedOrders: this.retainedOrders,
        budget: LOCAL_RETAINED_ORDER_BUDGET,
        retryAt: this.admissionRetryAt === 0 ? null : iso(this.admissionRetryAt * 1000),
      },
      strandedCredits: this.strandedCredits,
      parkedCounterpartyCredits: this.parkedCounterpartyCredits,
    };
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }
}

export function createHealthServer(health: MakerHealth): Server {
  return createServer((req, res) => {
    if (req.method !== "GET" || req.url !== "/health") {
      res.writeHead(404, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end('{"error":"not found"}\n');
      return;
    }
    const snapshot = health.snapshot();
    res.writeHead(snapshot.status === "ok" ? 200 : 503, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(`${JSON.stringify(snapshot)}\n`);
  });
}

export async function listenHealthServer(
  health: MakerHealth,
  host: string,
  port: number,
): Promise<Server> {
  const server = createHealthServer(health);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}
