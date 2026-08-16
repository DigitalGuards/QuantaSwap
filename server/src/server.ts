// QuantaSwap order book service. Plain node:http, zero runtime deps.
// Served same-origin behind nginx (/api -> 127.0.0.1:PORT) in production
// and behind the Vite dev proxy locally.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolveClientIp } from "./client-ip.js";
import { readConfig } from "./config.js";
import { ApiError, OrderStore, OrderStorePersistenceError } from "./store.js";
import { BoundedSseWriter } from "./stream.js";

const config = readConfig();
const MAX_BODY_BYTES = 4096;
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
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new ApiError(413, "body too large");
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
const ORDER_ID_RE = /^[0-9a-f]{16}$/;

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

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? "GET";
  const path = (req.url ?? "/").split("?")[0] ?? "/";
  const ip = clientIp(req);

  if (shuttingDown && path !== "/api/health") {
    sendJson(res, 503, { error: "order book is shutting down" });
    return;
  }

  // Heartbeats are read-class: they mutate nothing durable and a maker
  // with several listings pings often by design.
  const mutation = method !== "GET" && !path.endsWith("/heartbeat");
  if (rateLimited(ip, mutation)) {
    sendJson(res, 429, { error: "rate limited, slow down" });
    return;
  }

  if (method === "GET" && path === "/api/health") {
    const healthy = !shuttingDown && store.storageReady();
    sendJson(res, healthy ? 200 : 503, { status: healthy ? "ok" : "degraded" });
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
  if (method === "POST" && path === "/api/orders/take") {
    // Take by terms: fills the best open order at the caller's bounds or
    // better. Returns the taker token alongside the order, like accept.
    sendJson(res, 200, store.take(await readJsonBody(req), ip));
    return;
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
