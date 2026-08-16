// QuantaSwap order book service. Plain node:http with a small, lockfile-pinned
// cryptographic verification boundary.
// Served same-origin behind nginx (/api -> 127.0.0.1:PORT) in production
// and behind the Vite dev proxy locally.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolveClientIp } from "./client-ip.js";
import { readConfig } from "./config.js";
import { corsHeaders, preflightHeaders, type CorsMode } from "./cors.js";
import {
  FederationFeed,
  FederationResponseTooLargeError,
  MAX_FEDERATION_RESPONSE_BYTES,
  serializeFederationPage,
  type FederationPage,
} from "./federation.js";
import {
  FederationConcurrencyLimiter,
  FederationResetLimiter,
  FederationResponseCache,
  federationBearerAuthorized,
  federationResponseCacheKey,
} from "./federation-reset.js";
import { FederationPeerSync } from "./peer-sync.js";
import { ApiError, OrderStore, OrderStorePersistenceError } from "./store.js";
import { verifyOrderV1 } from "./order-signing.js";
import { BoundedSseWriter } from "./stream.js";

const config = readConfig();
const MAX_BODY_BYTES = 4096;
const MAX_SIGNED_BODY_BYTES = 32 * 1024;
let shuttingDown = false;

// Naive per-IP rate limit, resets every minute. Enough to blunt scripted
// spam on a testnet demo; Cloudflare fronts the real thing. Both ceilings
// leave room for the local market maker (un-proxied, so keyed to
// 127.0.0.1): at a 5s tick it issues one view GET plus one heartbeat per
// open listing PLUS one view GET per in-flight take. At multi-pair prod
// depth (28 listings) that is ~672 read-class calls/min before a single
// take is in flight, so the read ceiling is sized at roughly 2x that
// baseline; starving heartbeats flaps the maker "offline" mid-swap. A
// price-drift reprice cancels and reposts the whole book inside one
// mutation window.
const WINDOW_MS = 60_000;
const MAX_MUTATIONS_PER_WINDOW = 120;
const MAX_READS_PER_WINDOW = 1440;
const hits = new Map<string, { windowStart: number; reads: number; mutations: number }>();
const publicFederationResetLimiter = new FederationResetLimiter();
const publicFederationRequestLimiter = new FederationResetLimiter({
  perSourceLimit: 240,
  globalLimit: 3840,
});
const publicFederationConcurrencyLimiter = new FederationConcurrencyLimiter({
  perSourceLimit: 1,
  globalLimit: 4,
});
const authenticatedFederationResetLimiter = new FederationResetLimiter({
  perSourceLimit: 4,
  globalLimit: 64,
});
const authenticatedFederationRequestLimiter = new FederationResetLimiter({
  perSourceLimit: 240,
  globalLimit: 3840,
});
const authenticatedFederationConcurrencyLimiter = new FederationConcurrencyLimiter({
  perSourceLimit: 1,
  globalLimit: 16,
});
const federationResponseCache = new FederationResponseCache({
  maxEntries: 128,
  maxBytes: MAX_FEDERATION_RESPONSE_BYTES * 2,
  ttlMs: 5_000,
});
const serializedFederationPages = new WeakMap<FederationPage, string>();

function rateLimited(ip: string, mutation: boolean): boolean {
  const now = Date.now();
  let entry = hits.get(ip);
  if (!entry || now - entry.windowStart > WINDOW_MS) {
    entry = { windowStart: now, reads: 0, mutations: 0 };
    hits.set(ip, entry);
    if (hits.size > 10_000) hits.clear();
  }
  if (mutation) entry.mutations += 1;
  else entry.reads += 1;
  // Class-scoped: a burst of mutations (a full-book reprice) must not
  // starve reads (heartbeats, view polls), or the maker goes "offline"
  // and stalls in-flight swaps for the rest of the window.
  return mutation
    ? entry.mutations > MAX_MUTATIONS_PER_WINDOW
    : entry.reads > MAX_READS_PER_WINDOW;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  sendSerializedJson(res, status, body);
}

function sendSerializedJson(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function waitForResponse(
  res: ServerResponse,
  event: "drain" | "finish",
  timeoutMs: number,
): Promise<boolean> {
  if (timeoutMs <= 0 || res.destroyed) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      res.off(event, onSuccess);
      res.off("close", onFailure);
      res.off("error", onFailure);
      resolve(result);
    };
    const onSuccess = () => finish(true);
    const onFailure = () => finish(false);
    const timer = setTimeout(() => {
      res.destroy();
      finish(false);
    }, timeoutMs);
    timer.unref();
    res.once(event, onSuccess);
    res.once("close", onFailure);
    res.once("error", onFailure);
  });
}

async function sendFederationJson(res: ServerResponse, body: Buffer): Promise<void> {
  const deadline = Date.now() + config.streamBackpressureMs;
  res.writeHead(200, {
    "Content-Type": "application/json",
    "Content-Length": String(body.byteLength),
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
  });
  for (let offset = 0; offset < body.byteLength; offset += 64 * 1024) {
    if (res.destroyed) return;
    const accepted = res.write(body.subarray(offset, offset + 64 * 1024));
    if (!accepted && !(await waitForResponse(res, "drain", deadline - Date.now()))) {
      return;
    }
  }
  if (res.destroyed) return;
  const finished = waitForResponse(res, "finish", deadline - Date.now());
  res.end();
  await finished;
}

function federationPageBody(page: FederationPage): string {
  const cached = serializedFederationPages.get(page);
  if (cached !== undefined) return cached;
  try {
    const serialized = serializeFederationPage(page);
    serializedFederationPages.set(page, serialized);
    return serialized;
  } catch (error) {
    if (error instanceof FederationResponseTooLargeError) {
      throw new ApiError(503, "federation snapshot exceeds the response limit");
    }
    throw error;
  }
}

async function readJsonBody(
  req: IncomingMessage,
  maxBytes = MAX_BODY_BYTES,
): Promise<Record<string, unknown>> {
  const contentType = req.headers["content-type"];
  if (
    typeof contentType !== "string" ||
    contentType.split(";", 1)[0]?.trim().toLowerCase() !== "application/json"
  ) {
    throw new ApiError(415, "content type must be application/json");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > maxBytes) throw new ApiError(413, "body too large");
    chunks.push(buf);
  }
  if (size === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new ApiError(400, "body must be a JSON object");
  }
}

const store = new OrderStore(config.dataFile, { presenceTtlS: config.presenceTtlS });
const federationFeed = new FederationFeed(config.federationDataFile);
let federationHealthy = true;

// The order store and relay feed use separate atomic files. Reconcile every
// currently live public proof before serving so a crash between those writes
// cannot leave an accepted mutation permanently invisible to existing peers.
federationFeed.reconcileSnapshot(store.federationSnapshot());

store.subscribeFederation((event) => {
  try {
    federationFeed.append(
      event,
      Math.floor(Date.now() / 1000),
      store.federationSnapshot(),
    );
    federationHealthy = true;
  } catch (error) {
    federationHealthy = false;
    console.error("[orderbook] federation event persistence failed:", error);
    initiateShutdown("federation storage failure", 1);
  }
});

const peerSync = new FederationPeerSync({
  peers: config.federationPeers,
  peerIds: config.federationPeerIds,
  peerTokens: config.federationPeerTokens,
  timeoutMs: config.federationRequestTimeoutMs,
  staleAfterMs: Math.max(
    config.federationSyncMs * 3,
    config.federationRequestTimeoutMs * 2,
  ),
  apply: (event, peer) => {
    try {
      const peerIndex = config.federationPeers.indexOf(peer);
      const peerId = peerIndex === -1 ? "peer-unknown" : config.federationPeerIds[peerIndex]!;
      store.applyFederationEvent(event, peerId);
      return "applied";
    } catch (error) {
      if (error instanceof OrderStorePersistenceError) {
        console.error("[orderbook] fatal persistence failure during federation sync");
        initiateShutdown("storage failure", 1);
        throw error;
      }
      if (
        error instanceof ApiError &&
        (error.code === "federation_dependency" ||
          error.code === "transient_capacity")
      ) {
        return "deferred";
      }
      return "rejected";
    }
  },
  onError: (peer, error) => {
    const peerIndex = config.federationPeers.indexOf(peer);
    const peerId = peerIndex === -1 ? "peer-unknown" : config.federationPeerIds[peerIndex];
    console.warn(
      `[orderbook] federation ${peerId} sync failed:`,
      error instanceof Error ? error.message : "unknown transport error",
    );
  },
});
const peerSyncTimer =
  config.federationPeers.length === 0
    ? undefined
    : setInterval(() => void peerSync.syncAll(), config.federationSyncMs);
peerSyncTimer?.unref();
if (config.federationPeers.length > 0) setImmediate(() => void peerSync.syncAll());
const ORDER_ID_RE = /^(?:[0-9a-f]{16}|[0-9a-f]{64})$/;

function clientIp(req: IncomingMessage): string {
  return resolveClientIp(
    req.socket.remoteAddress,
    {
      "cf-connecting-ip": req.headers["cf-connecting-ip"],
      "x-forwarded-for": req.headers["x-forwarded-for"],
    },
    config.proxyTrust,
  );
}

// --- Book stream (SSE) ---------------------------------------------------
// Push replaces polling so the visible book is at most a broadcast behind
// reality; a taken row disappears before a second visitor can click it.
// X-Accel-Buffering keeps nginx from buffering the stream; the periodic
// ping keeps Cloudflare's idle timeout (~100s) away.

const MAX_STREAM_CLIENTS = 200;
const MAX_STREAM_CLIENTS_PER_IP = 4;
const STREAM_TICK_MS = 15_000;
const streamClients = new Map<ServerResponse, BoundedSseWriter>();
const streamIpCounts = new Map<string, number>();
let lastBookPayload: string | null = null;
let pushQueued = false;

const bookPayload = (): string => JSON.stringify({ orders: store.listOpen() });

function pushBook(): void {
  if (streamClients.size === 0) {
    lastBookPayload = null;
    return;
  }
  const payload = bookPayload();
  if (payload === lastBookPayload) return;
  lastBookPayload = payload;
  for (const writer of [...streamClients.values()]) {
    writer.write(`event: book\ndata: ${payload}\n\n`);
  }
}

// Coalesce bursts (and break the pushBook -> sweep -> notify cycle).
store.subscribe(() => {
  if (pushQueued) return;
  pushQueued = true;
  setImmediate(() => {
    pushQueued = false;
    pushBook();
  });
});

// Presence expiry has no event to hook, so re-check on a timer; when the
// book is unchanged the tick doubles as the keep-alive ping.
setInterval(() => {
  const before = lastBookPayload;
  pushBook();
  if (lastBookPayload !== before) return;
  for (const writer of [...streamClients.values()]) {
    writer.write(": ping\n\n");
  }
}, STREAM_TICK_MS).unref();

function removeStream(res: ServerResponse, ip: string): void {
  if (!streamClients.delete(res)) return;
  const count = (streamIpCounts.get(ip) ?? 1) - 1;
  if (count <= 0) streamIpCounts.delete(ip);
  else streamIpCounts.set(ip, count);
}

function openStream(req: IncomingMessage, res: ServerResponse, ip: string): void {
  const perIp = streamIpCounts.get(ip) ?? 0;
  if (streamClients.size >= MAX_STREAM_CLIENTS || perIp >= MAX_STREAM_CLIENTS_PER_IP) {
    sendJson(res, 503, { error: "too many stream connections; fall back to polling" });
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const writer = new BoundedSseWriter(res, config.streamBackpressureMs, () =>
    removeStream(res, ip),
  );
  streamClients.set(res, writer);
  streamIpCounts.set(ip, perIp + 1);
  req.on("close", () => writer.close());
  writer.write(`event: book\ndata: ${bookPayload()}\n\n`);
}

// --------------------------------------------------------------------------

function requestOrigin(req: IncomingMessage): string | undefined {
  const origin = req.headers.origin;
  return typeof origin === "string" ? origin : undefined;
}

function corsMode(method: string, path: string): CorsMode {
  return method === "GET" &&
    (path === "/api/health" ||
      path === "/api/status" ||
      path === "/api/orders" ||
      path === "/api/orders/stream" ||
      path === "/api/federation/v1/events")
    ? "public-read"
    : "configured-origin";
}

function applyHeaders(res: ServerResponse, headers: Record<string, string>): void {
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://orderbook.invalid");
  const path = url.pathname;
  const ip = clientIp(req);

  if (method === "OPTIONS") {
    const headers = preflightHeaders(
      requestOrigin(req),
      typeof req.headers["access-control-request-method"] === "string"
        ? req.headers["access-control-request-method"]
        : undefined,
      typeof req.headers["access-control-request-headers"] === "string"
        ? req.headers["access-control-request-headers"]
        : undefined,
      config.corsOrigins,
    );
    if (headers === null) {
      sendJson(res, 403, { error: "cross-origin request is not allowed" });
    } else {
      applyHeaders(res, headers);
      res.writeHead(204, { "Cache-Control": "no-store" });
      res.end();
    }
    return;
  }
  applyHeaders(res, corsHeaders(requestOrigin(req), corsMode(method, path), config.corsOrigins));

  if (shuttingDown && path !== "/api/health" && path !== "/api/status") {
    sendJson(res, 503, { error: "order book is shutting down" });
    return;
  }

  // Heartbeats are read-class: they mutate nothing durable and a maker
  // with several listings pings often by design.
  const mutation = method !== "GET" && !path.endsWith("/heartbeat");
  if (path !== "/api/federation/v1/events" && rateLimited(ip, mutation)) {
    sendJson(res, 429, { error: "rate limited, slow down" });
    return;
  }

  if (method === "GET" && path === "/api/health") {
    const healthy =
      !shuttingDown &&
      store.storageReady() &&
      federationFeed.storageReady() &&
      federationHealthy;
    sendJson(res, healthy ? 200 : 503, { status: healthy ? "ok" : "degraded" });
    return;
  }
  if (method === "GET" && path === "/api/status") {
    const storageReady = store.storageReady() && federationFeed.storageReady();
    const healthy = !shuttingDown && storageReady && federationHealthy;
    sendJson(res, healthy ? 200 : 503, {
      schemaVersion: 1,
      status: healthy ? "ok" : "degraded",
      uptimeS: Math.floor(process.uptime()),
      feed: {
        ready: federationFeed.storageReady() && federationHealthy,
        ...federationFeed.status(),
      },
      federation: peerSync.status(),
    });
    return;
  }
  if (method === "GET" && path === "/api/federation/v1/events") {
    const unexpected = [...url.searchParams.keys()].some(
      (key) => key !== "cursor" && key !== "limit",
    );
    if (unexpected) throw new ApiError(400, "unsupported federation query parameter");
    const rawLimit = url.searchParams.get("limit") ?? "256";
    if (!/^[0-9]+$/.test(rawLimit)) {
      throw new ApiError(400, "federation limit must be an integer");
    }
    const limit = Number(rawLimit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) {
      throw new ApiError(400, "federation limit must be between 1 and 256");
    }
    const cursor = url.searchParams.get("cursor");
    const reset = federationFeed.requiresReset(cursor);
    const authenticated = federationBearerAuthorized(
      req.headers.authorization,
      config.federationReadToken,
    );
    const requestLimiter = authenticated
      ? authenticatedFederationRequestLimiter
      : publicFederationRequestLimiter;
    const resetLimiter = authenticated
      ? authenticatedFederationResetLimiter
      : publicFederationResetLimiter;
    const concurrencyLimiter = authenticated
      ? authenticatedFederationConcurrencyLimiter
      : publicFederationConcurrencyLimiter;
    const source = `${authenticated ? "peer" : "public"}:${ip}`;
    const release = concurrencyLimiter.acquire(source);
    if (release === null) {
      throw new ApiError(429, "federation response already in progress");
    }
    try {
      if (!requestLimiter.allow(source)) {
        throw new ApiError(429, "federation request rate limited, retry later");
      }
      if (reset && !resetLimiter.allow(source)) {
        throw new ApiError(429, "federation reset rate limited, retry later");
      }
      const status = federationFeed.status();
      const cacheKey = federationResponseCacheKey(
        reset,
        cursor,
        limit,
        status.oldestSequence,
        status.latestSequence,
      );
      const body = federationResponseCache.getOrCreate(cacheKey, () => {
        const page = federationFeed.page(cursor, limit, () => store.federationSnapshot());
        return federationPageBody(page);
      });
      await sendFederationJson(res, body);
    } finally {
      release();
    }
    return;
  }
  if (method === "GET" && path === "/api/orders/stream") {
    openStream(req, res, ip);
    return;
  }
  if (method === "GET" && path === "/api/orders") {
    sendJson(res, 200, { orders: store.listOpen() });
    return;
  }
  if (method === "POST" && path === "/api/orders") {
    sendJson(res, 201, store.create(await readJsonBody(req), ip));
    return;
  }
  if (method === "POST" && path === "/api/orders/signed") {
    const body = await readJsonBody(req, MAX_SIGNED_BODY_BYTES);
    const verified = verifyOrderV1(body["order"], body["auth"]);
    const expectedKeys = verified.terms.visibility === "private"
      ? ["auth", "makerToken", "order", "shareToken"]
      : ["auth", "makerToken", "order"];
    const actualKeys = Object.keys(body).sort();
    if (
      actualKeys.length !== expectedKeys.length ||
      actualKeys.some((key, index) => key !== expectedKeys[index])
    ) {
      throw new ApiError(400, "signed create request has unexpected fields");
    }
    sendJson(
      res,
      201,
      store.createVerified(
        verified,
        {
          makerToken: body["makerToken"],
          ...(body["shareToken"] === undefined
            ? {}
            : { shareToken: body["shareToken"] }),
        },
        ip,
      ),
    );
    return;
  }
  if (method === "POST" && path === "/api/orders/take") {
    // Take by terms: fills the best open order at the caller's bounds or
    // better. Returns the taker token alongside the order, like accept.
    sendJson(res, 200, store.take(await readJsonBody(req), ip));
    return;
  }

  const signedCancelMatch = /^\/api\/orders\/([^/]+)\/cancel\/signed$/.exec(path);
  if (signedCancelMatch && method === "POST") {
    const id = signedCancelMatch[1] ?? "";
    if (!ORDER_ID_RE.test(id)) throw new ApiError(404, "order not found");
    const body = await readJsonBody(req, MAX_SIGNED_BODY_BYTES);
    const headerToken = req.headers["x-maker-token"];
    const order = store.cancelSigned(
      id,
      body["cancel"],
      body["auth"],
      typeof headerToken === "string" ? headerToken : body["token"],
    );
    sendJson(res, 200, { order });
    return;
  }

  const protocolMatch = /^\/api\/orders\/([^/]+)\/(intents|fill)$/.exec(path);
  if (protocolMatch) {
    const id = protocolMatch[1] ?? "";
    const action = protocolMatch[2];
    if (!ORDER_ID_RE.test(id)) throw new ApiError(404, "order not found");
    if (action === "intents" && method === "GET") {
      const makerToken = req.headers["x-maker-token"];
      sendJson(res, 200, {
        intents: store.listFillIntents(
          id,
          typeof makerToken === "string" ? makerToken : undefined,
        ),
      });
      return;
    }
    if (action === "intents" && method === "POST") {
      const body = await readJsonBody(req, MAX_SIGNED_BODY_BYTES);
      const shareToken = req.headers["x-share-token"];
      const intent = store.submitFillIntent(
        id,
        body["intent"],
        body["auth"],
        ip,
        typeof shareToken === "string" ? shareToken : body["shareToken"],
      );
      sendJson(res, 201, { intent });
      return;
    }
    if (action === "fill" && method === "POST") {
      const body = await readJsonBody(req, MAX_SIGNED_BODY_BYTES);
      const makerToken = req.headers["x-maker-token"];
      const order = store.fillOrder(
        id,
        body["fill"],
        body["auth"],
        body["intent"],
        body["intentAuth"],
        typeof makerToken === "string" ? makerToken : body["token"],
      );
      sendJson(res, 200, { order });
      return;
    }
  }

  const match = /^\/api\/orders\/([^/]+)(?:\/(accept|hashlock|cancel|release|heartbeat))?$/.exec(
    path,
  );
  if (match) {
    const id = match[1] ?? "";
    const action = match[2];
    if (!ORDER_ID_RE.test(id)) throw new ApiError(404, "order not found");
    if (method === "GET" && action === undefined) {
      // Private orders gate on the share token; it rides in a header (a
      // query string would land in nginx/CF access logs, and the browser
      // client keeps it in the URL fragment, which never leaves the page).
      const share = req.headers["x-share-token"];
      sendJson(res, 200, { order: store.get(id, typeof share === "string" ? share : undefined) });
      return;
    }
    if (method === "POST" && action !== undefined) {
      const body = await readJsonBody(req);
      if (action === "accept") {
        // Returns the taker token alongside the order, like create does
        // for the maker token.
        sendJson(res, 200, store.accept(id, body, ip));
        return;
      }
      const order =
        action === "hashlock"
          ? store.announceHashlock(id, body)
          : action === "release"
            ? store.release(id, body)
            : action === "heartbeat"
              ? store.heartbeat(id, body)
              : store.cancel(id, body);
      sendJson(res, 200, { order });
      return;
    }
  }

  sendJson(res, 404, { error: "not found" });
}

const server = createServer((req, res) => {
  route(req, res).catch((err: unknown) => {
    if (err instanceof ApiError) {
      sendJson(res, err.status, { error: err.message });
    } else if (err instanceof OrderStorePersistenceError) {
      console.error("[orderbook] fatal persistence failure; stopping");
      sendJson(res, 503, { error: "order book storage is unavailable" });
      initiateShutdown("storage failure", 1);
    } else {
      console.error("[orderbook] unhandled error:", err);
      sendJson(res, 500, { error: "internal error" });
    }
  });
});

server.requestTimeout = config.requestTimeoutMs;
server.headersTimeout = config.requestTimeoutMs;
server.keepAliveTimeout = 5000;
server.maxRequestsPerSocket = 1000;

let shutdownTimer: NodeJS.Timeout | undefined;

function initiateShutdown(reason: string, exitCode = 0): void {
  if (shuttingDown) {
    const currentExitCode = typeof process.exitCode === "number" ? process.exitCode : 0;
    if (exitCode > currentExitCode) process.exitCode = exitCode;
    return;
  }
  shuttingDown = true;
  process.exitCode = exitCode;
  console.log(`[orderbook] stopping (${reason})`);

  if (peerSyncTimer !== undefined) clearInterval(peerSyncTimer);
  for (const writer of [...streamClients.values()]) writer.end();
  server.close((error) => {
    if (shutdownTimer !== undefined) clearTimeout(shutdownTimer);
    if (error !== undefined) {
      console.error("[orderbook] shutdown error:", error.message);
      process.exitCode = 1;
    }
  });
  server.closeIdleConnections();
  shutdownTimer = setTimeout(() => {
    console.error("[orderbook] graceful shutdown deadline exceeded");
    process.exitCode = 1;
    server.closeAllConnections();
  }, config.shutdownTimeoutMs);
  shutdownTimer.unref();
}

process.once("SIGTERM", () => initiateShutdown("SIGTERM"));
process.once("SIGINT", () => initiateShutdown("SIGINT"));

server.on("clientError", (_error, socket) => {
  if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
});

server.on("error", (error) => {
  console.error("[orderbook] server error:", error.message);
  process.exitCode = 1;
});

server.listen(config.port, config.host, () => {
  console.log(
    `[orderbook] listening on ${config.host}:${config.port}, data file ${config.dataFile}`,
  );
});
