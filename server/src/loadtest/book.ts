// Runs a real order-book process for the harness: the built dist/server.js
// with a throwaway data file and feed file, the production persistence path,
// and nothing stubbed out.

import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { setPriority } from "node:os";
import { request } from "node:http";

export interface BookOptions {
  port: number;
  dataFile: string;
  federationDataFile: string;
  /** Scheduling niceness for the book process, matching the harness. */
  niceness: number;
  /** Captured stderr and stdout, so a crash is visible in the report. */
  log: string[];
}

export interface Book {
  readonly pid: number;
  readonly port: number;
  readonly exited: boolean;
  readonly exitCode: number | null;
  stop(): Promise<void>;
}

const BOOK_ENV_BASE: Record<string, string> = {
  ORDERBOOK_HOST: "127.0.0.1",
  ORDERBOOK_FEDERATION_PEERS: "",
  ORDERBOOK_FEDERATION_PEER_IDS: "",
  ORDERBOOK_FEDERATION_PEER_TOKENS: "",
  ORDERBOOK_FEDERATION_ONION_ONLY: "false",
  ORDERBOOK_FEDERATION_ONION_PROXY: "",
  ORDERBOOK_FEDERATION_READ_TOKEN: "",
  // The harness reaches the book over loopback, so the service's real
  // trusted-proxy path resolves the forwarded address per synthetic client.
  ORDERBOOK_TRUST_PROXY: "loopback",
  ORDERBOOK_CORS_ORIGINS: "http://127.0.0.1:5173",
};

export async function startBook(options: BookOptions): Promise<Book> {
  const child: ChildProcess = spawn(
    process.execPath,
    [new URL("../server.js", import.meta.url).pathname],
    {
      env: {
        ...process.env,
        ...BOOK_ENV_BASE,
        PORT: String(options.port),
        ORDERBOOK_DATA: options.dataFile,
        ORDERBOOK_FEDERATION_DATA: options.federationDataFile,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const pid = child.pid;
  if (pid === undefined) throw new Error("order book process failed to start");
  try {
    setPriority(pid, options.niceness);
  } catch {
    // Raising niceness can fail under an unusual policy; the harness still
    // runs, only without the scheduling courtesy.
  }
  const collect = (chunk: Buffer): void => {
    for (const line of chunk.toString("utf8").split("\n")) {
      if (line.trim().length > 0) options.log.push(line.trim());
    }
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);

  const state = { exited: false, exitCode: null as number | null };
  child.once("exit", (code) => {
    state.exited = true;
    state.exitCode = code;
  });

  await waitForHealth(options.port, 20_000);

  return {
    pid,
    port: options.port,
    get exited() {
      return state.exited;
    },
    get exitCode() {
      return state.exitCode;
    },
    async stop() {
      if (state.exited) return;
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 12_000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}

export async function waitForHealth(
  port: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no attempt made";
  while (Date.now() < deadline) {
    const probe = await probeHealth(port);
    if (probe.status === 200) return;
    lastError = probe.detail;
    await sleep(100);
  }
  throw new Error(`order book did not become healthy: ${lastError}`);
}

export function probeHealth(
  port: number,
  forwardedFor?: string,
): Promise<{ status: number; detail: string; latencyMs: number }> {
  const startedAt = performance.now();
  return new Promise((resolve) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: "/api/health",
        method: "GET",
        ...(forwardedFor === undefined
          ? {}
          : { headers: { "X-Forwarded-For": forwardedFor } }),
      },
      (res) => {
        res.resume();
        res.once("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            detail: `status ${String(res.statusCode)}`,
            latencyMs: performance.now() - startedAt,
          }),
        );
      },
    );
    req.setTimeout(10_000, () => req.destroy(new Error("health probe timeout")));
    req.once("error", (error: Error) =>
      resolve({
        status: 0,
        detail: error.message,
        latencyMs: performance.now() - startedAt,
      }),
    );
    req.end();
  });
}

export interface ProcessCpu {
  /** Clock ticks are assumed to be the Linux default of 100 per second. */
  userMs: number;
  systemMs: number;
  rssBytes: number;
}

export function readProcessCpu(pid: number): ProcessCpu | undefined {
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, "utf8");
    // The second field is the comm name in parentheses and may contain
    // spaces, so fields are counted from after the closing parenthesis.
    const tail = stat.slice(stat.lastIndexOf(") ") + 2).split(" ");
    const userTicks = Number(tail[11]);
    const systemTicks = Number(tail[12]);
    const rssPages = Number(tail[21]);
    if (!Number.isFinite(userTicks) || !Number.isFinite(systemTicks)) {
      return undefined;
    }
    return {
      userMs: userTicks * 10,
      systemMs: systemTicks * 10,
      rssBytes: rssPages * 4096,
    };
  } catch {
    return undefined;
  }
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
