import { createServer, type Server } from "node:http";

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
      this.lastTickErrorCount > 0
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
