export type ProxyTrust = "none" | "loopback" | "all";

export interface ServerConfig {
  host: string;
  port: number;
  dataFile: string;
  presenceTtlS: number;
  proxyTrust: ProxyTrust;
  requestTimeoutMs: number;
  shutdownTimeoutMs: number;
  streamBackpressureMs: number;
}

function integerEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  if (!/^[0-9]+$/.test(raw)) throw new Error(`${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return value;
}

function nonEmptyEnv(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const value = env[name] ?? fallback;
  if (value.trim() !== value || value.length === 0) {
    throw new Error(`${name} must be a non-empty value without surrounding whitespace`);
  }
  return value;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const rawProxyTrust = env["ORDERBOOK_TRUST_PROXY"] ?? "loopback";
  if (rawProxyTrust !== "none" && rawProxyTrust !== "loopback" && rawProxyTrust !== "all") {
    throw new Error("ORDERBOOK_TRUST_PROXY must be none, loopback, or all");
  }

  return {
    host: nonEmptyEnv(env, "ORDERBOOK_HOST", "127.0.0.1"),
    port: integerEnv(env, "PORT", 8091, 1, 65_535),
    dataFile: nonEmptyEnv(
      env,
      "ORDERBOOK_DATA",
      new URL("../data/orders.json", import.meta.url).pathname,
    ),
    presenceTtlS: integerEnv(env, "PRESENCE_TTL_S", 90, 1, 3600),
    proxyTrust: rawProxyTrust,
    requestTimeoutMs: integerEnv(env, "ORDERBOOK_REQUEST_TIMEOUT_MS", 15_000, 1000, 120_000),
    shutdownTimeoutMs: integerEnv(env, "ORDERBOOK_SHUTDOWN_TIMEOUT_MS", 10_000, 1000, 60_000),
    streamBackpressureMs: integerEnv(
      env,
      "ORDERBOOK_STREAM_BACKPRESSURE_MS",
      10_000,
      1000,
      60_000,
    ),
  };
}
