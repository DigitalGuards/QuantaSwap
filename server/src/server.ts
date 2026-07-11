// QuantaSwap order book service. Plain node:http, zero runtime deps.
// Served same-origin behind nginx (/api -> 127.0.0.1:PORT) in production
// and behind the Vite dev proxy locally.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { ApiError, OrderStore } from "./store.js";

const PORT = Number(process.env["PORT"] ?? 8091);
const DATA_FILE = process.env["ORDERBOOK_DATA"] ?? new URL("../data/orders.json", import.meta.url).pathname;
const PRESENCE_TTL_S = Number(process.env["PRESENCE_TTL_S"] ?? 90);
const MAX_BODY_BYTES = 4096;

// Naive per-IP rate limit, resets every minute. Enough to blunt scripted
// spam on a testnet demo; Cloudflare fronts the real thing. The read
// ceiling leaves room for the local market maker (un-proxied, so keyed
// to 127.0.0.1): at a 5s tick it issues one view GET plus one heartbeat
// per open listing.
const WINDOW_MS = 60_000;
const MAX_MUTATIONS_PER_WINDOW = 30;
const MAX_READS_PER_WINDOW = 720;
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
  return entry.mutations > MAX_MUTATIONS_PER_WINDOW || entry.reads > MAX_READS_PER_WINDOW;
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

const store = new OrderStore(DATA_FILE, { presenceTtlS: PRESENCE_TTL_S });
const ORDER_ID_RE = /^[0-9a-f]{16}$/;

/** Behind nginx everything arrives from 127.0.0.1, so prefer the proxy
 *  headers. The port is loopback-bound, so they cannot be spoofed from
 *  outside. */
function clientIp(req: IncomingMessage): string {
  const cf = req.headers["cf-connecting-ip"];
  if (typeof cf === "string" && cf.length > 0) return cf;
  const fwd = req.headers["x-forwarded-for"];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim();
  if (first) return first;
  return req.socket.remoteAddress ?? "unknown";
}

// --- Book stream (SSE) ---------------------------------------------------
// Push replaces polling so the visible book is at most a broadcast behind
// reality; a taken row disappears before a second visitor can click it.
// X-Accel-Buffering keeps nginx from buffering the stream; the periodic
// ping keeps Cloudflare's idle timeout (~100s) away.

const MAX_STREAM_CLIENTS = 200;
const MAX_STREAM_CLIENTS_PER_IP = 4;
const STREAM_TICK_MS = 15_000;
const streamClients = new Set<ServerResponse>();
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
  for (const res of [...streamClients]) {
    try {
      res.write(`event: book\ndata: ${payload}\n\n`);
    } catch {
      // close handler removes it
    }
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
  for (const res of [...streamClients]) {
    try {
      res.write(": ping\n\n");
    } catch {
      // close handler removes it
    }
  }
}, STREAM_TICK_MS).unref();

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
  res.write(`event: book\ndata: ${bookPayload()}\n\n`);
  streamClients.add(res);
  streamIpCounts.set(ip, perIp + 1);
  req.on("close", () => {
    streamClients.delete(res);
    const n = (streamIpCounts.get(ip) ?? 1) - 1;
    if (n <= 0) streamIpCounts.delete(ip);
    else streamIpCounts.set(ip, n);
  });
}

// --------------------------------------------------------------------------

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? "GET";
  const path = (req.url ?? "/").split("?")[0] ?? "/";
  const ip = clientIp(req);

  // Heartbeats are read-class: they mutate nothing durable and a maker
  // with several listings pings often by design.
  const mutation = method !== "GET" && !path.endsWith("/heartbeat");
  if (rateLimited(ip, mutation)) {
    sendJson(res, 429, { error: "rate limited, slow down" });
    return;
  }

  if (method === "GET" && path === "/api/health") {
    sendJson(res, 200, { status: "ok" });
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
    sendJson(res, 201, store.create(await readJsonBody(req)));
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
      sendJson(res, 200, { order: store.get(id) });
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
    } else {
      console.error("[orderbook] unhandled error:", err);
      sendJson(res, 500, { error: "internal error" });
    }
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[orderbook] listening on 127.0.0.1:${PORT}, data file ${DATA_FILE}`);
});
