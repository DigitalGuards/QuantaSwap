import { resolve } from "node:path";

export type ProxyTrust = "none" | "loopback" | "all";

export interface ServerConfig {
  host: string;
  port: number;
  dataFile: string;
  federationDataFile: string;
  federationPeers: string[];
  federationPeerIds: string[];
  federationPeerTokens: Array<string | null>;
  federationReadToken: string | null;
  federationAllowInsecurePeerTokens: boolean;
  federationSyncMs: number;
  federationRequestTimeoutMs: number;
  corsOrigins: string[];
  presenceTtlS: number;
  proxyTrust: ProxyTrust;
  requestTimeoutMs: number;
  shutdownTimeoutMs: number;
  streamBackpressureMs: number;
}

const MAX_FEDERATION_PEERS = 16;
const FEDERATION_PEER_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const FEDERATION_TOKEN_RE = /^[0-9a-f]{64}$/;

function booleanEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: boolean,
): boolean {
  const raw = env[name];
  if (raw === undefined) return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`${name} must be true or false`);
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

function csvEnv(env: NodeJS.ProcessEnv, name: string): string[] {
  const raw = env[name];
  if (raw === undefined || raw === "") return [];
  const values = raw.split(",").map((value) => value.trim());
  if (values.some((value) => value.length === 0)) {
    throw new Error(`${name} must be a comma-separated list without empty entries`);
  }
  if (new Set(values).size !== values.length) throw new Error(`${name} contains duplicates`);
  return values;
}

function federationPeers(env: NodeJS.ProcessEnv): string[] {
  const configured = csvEnv(env, "ORDERBOOK_FEDERATION_PEERS");
  if (configured.length > MAX_FEDERATION_PEERS) {
    throw new Error(`ORDERBOOK_FEDERATION_PEERS cannot contain more than ${MAX_FEDERATION_PEERS} peers`);
  }
  const peers = configured.map((raw) => {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new Error("ORDERBOOK_FEDERATION_PEERS contains an invalid URL");
    }
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      throw new Error("ORDERBOOK_FEDERATION_PEERS URLs must be plain HTTP(S) base URLs");
    }
    url.pathname = url.pathname.replace(/\/$/, "");
    return url.toString().replace(/\/$/, "");
  });
  if (new Set(peers).size !== peers.length) {
    throw new Error("ORDERBOOK_FEDERATION_PEERS contains equivalent duplicate URLs");
  }
  return peers;
}

function federationPeerIds(env: NodeJS.ProcessEnv, peers: readonly string[]): string[] {
  const configured = csvEnv(env, "ORDERBOOK_FEDERATION_PEER_IDS");
  if (configured.length === 0) return peers.map((_peer, index) => `peer-${index + 1}`);
  if (configured.length !== peers.length) {
    throw new Error("ORDERBOOK_FEDERATION_PEER_IDS must contain one id for every peer");
  }
  if (configured.some((id) => !FEDERATION_PEER_ID_RE.test(id))) {
    throw new Error(
      "ORDERBOOK_FEDERATION_PEER_IDS entries must be lowercase letters, numbers, or internal hyphens",
    );
  }
  return configured;
}

function federationPeerTokens(
  env: NodeJS.ProcessEnv,
  peers: readonly string[],
): Array<string | null> {
  const raw = env["ORDERBOOK_FEDERATION_PEER_TOKENS"];
  if (raw === undefined || raw === "") return peers.map(() => null);
  const tokens = raw.split(",");
  if (tokens.length !== peers.length) {
    throw new Error("ORDERBOOK_FEDERATION_PEER_TOKENS must contain one token for every peer");
  }
  if (tokens.some((token) => !FEDERATION_TOKEN_RE.test(token))) {
    throw new Error("ORDERBOOK_FEDERATION_PEER_TOKENS entries must be 32 bytes of lowercase hex");
  }
  return tokens;
}

function federationReadToken(env: NodeJS.ProcessEnv): string | null {
  const raw = env["ORDERBOOK_FEDERATION_READ_TOKEN"];
  if (raw === undefined || raw === "") return null;
  if (!FEDERATION_TOKEN_RE.test(raw)) {
    throw new Error("ORDERBOOK_FEDERATION_READ_TOKEN must be 32 bytes of lowercase hex");
  }
  return raw;
}

function corsOrigins(env: NodeJS.ProcessEnv): string[] {
  return csvEnv(env, "ORDERBOOK_CORS_ORIGINS").map((raw) => {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new Error("ORDERBOOK_CORS_ORIGINS contains an invalid origin");
    }
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.origin !== raw ||
      url.username !== "" ||
      url.password !== ""
    ) {
      throw new Error("ORDERBOOK_CORS_ORIGINS entries must be exact HTTP(S) origins");
    }
    return raw;
  });
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const rawProxyTrust = env["ORDERBOOK_TRUST_PROXY"] ?? "loopback";
  if (rawProxyTrust !== "none" && rawProxyTrust !== "loopback" && rawProxyTrust !== "all") {
    throw new Error("ORDERBOOK_TRUST_PROXY must be none, loopback, or all");
  }

  const dataFile = nonEmptyEnv(
    env,
    "ORDERBOOK_DATA",
    new URL("../data/orders.json", import.meta.url).pathname,
  );
  const peers = federationPeers(env);
  const federationDataFile = nonEmptyEnv(
    env,
    "ORDERBOOK_FEDERATION_DATA",
    `${dataFile}.federation`,
  );
  if (resolve(dataFile) === resolve(federationDataFile)) {
    throw new Error("ORDERBOOK_DATA and ORDERBOOK_FEDERATION_DATA must be different files");
  }
  const peerTokens = federationPeerTokens(env, peers);
  const allowInsecurePeerTokens = booleanEnv(
    env,
    "ORDERBOOK_FEDERATION_ALLOW_INSECURE_PEER_TOKENS",
    false,
  );
  if (
    !allowInsecurePeerTokens &&
    peers.some((peer, index) => peerTokens[index] !== null && new URL(peer).protocol !== "https:")
  ) {
    throw new Error(
      "ORDERBOOK_FEDERATION_PEER_TOKENS require HTTPS peers unless insecure lab mode is enabled",
    );
  }
  return {
    host: nonEmptyEnv(env, "ORDERBOOK_HOST", "127.0.0.1"),
    port: integerEnv(env, "PORT", 8091, 1, 65_535),
    dataFile,
    federationDataFile,
    federationPeers: peers,
    federationPeerIds: federationPeerIds(env, peers),
    federationPeerTokens: peerTokens,
    federationReadToken: federationReadToken(env),
    federationAllowInsecurePeerTokens: allowInsecurePeerTokens,
    federationSyncMs: integerEnv(env, "ORDERBOOK_FEDERATION_SYNC_MS", 5000, 1000, 300_000),
    federationRequestTimeoutMs: integerEnv(
      env,
      "ORDERBOOK_FEDERATION_REQUEST_TIMEOUT_MS",
      10_000,
      1000,
      120_000,
    ),
    corsOrigins: corsOrigins(env),
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
