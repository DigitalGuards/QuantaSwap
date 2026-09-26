// HTTP and SSE clients for the load harness. Every request carries an
// X-Forwarded-For value so the book resolves a distinct source per synthetic
// client through its real trusted-proxy path (ORDERBOOK_TRUST_PROXY=loopback),
// with no test-only branch in the service.

import { Agent, request, type IncomingMessage } from "node:http";
import type { EndpointMetrics } from "./metrics.js";

export interface Reply {
  status: number;
  body: Record<string, unknown> | undefined;
  latencyMs: number;
  /** Set when the request never produced a status line. */
  transportError?: string;
}

export interface ClientOptions {
  port: number;
  metrics: EndpointMetrics;
  maxSockets: number;
  requestTimeoutMs: number;
}

export class BookClient {
  private readonly agent: Agent;
  readonly port: number;

  constructor(private readonly options: ClientOptions) {
    this.port = options.port;
    this.agent = new Agent({
      keepAlive: true,
      maxSockets: options.maxSockets,
      maxFreeSockets: options.maxSockets,
      keepAliveMsecs: 4000,
    });
  }

  destroy(): void {
    this.agent.destroy();
  }

  async send(
    label: string,
    method: "GET" | "POST",
    path: string,
    ip: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<Reply> {
    const payload =
      body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf8");
    const headers: Record<string, string> = {
      "X-Forwarded-For": ip,
      ...extraHeaders,
    };
    if (payload !== undefined) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(payload.byteLength);
    }
    const startedAt = performance.now();
    const reply = await new Promise<Reply>((resolve) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: this.options.port,
          method,
          path,
          headers,
          agent: this.agent,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            resolve({
              status: res.statusCode ?? 0,
              body: parseJson(Buffer.concat(chunks)),
              latencyMs: performance.now() - startedAt,
            });
          });
        },
      );
      req.setTimeout(this.options.requestTimeoutMs, () => {
        req.destroy(new Error("client timeout"));
      });
      req.once("error", (error: Error) => {
        resolve({
          status: 0,
          body: undefined,
          latencyMs: performance.now() - startedAt,
          transportError: error.message,
        });
      });
      if (payload !== undefined) req.write(payload);
      req.end();
    });
    if (reply.transportError === undefined) {
      this.options.metrics.record(label, reply.latencyMs, reply.status);
    } else {
      this.options.metrics.recordError(
        label,
        reply.latencyMs,
        reply.transportError,
      );
    }
    return reply;
  }
}

function parseJson(buffer: Buffer): Record<string, unknown> | undefined {
  if (buffer.byteLength === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(buffer.toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export interface SseEvent {
  /** Monotonic receipt time, comparable with performance.now(). */
  atMs: number;
  name: string;
  data: string;
}

/** One SSE subscriber. Frames are split on the blank-line delimiter and timed
 *  at the chunk that completed them, which is the delivery lag the browser
 *  would observe minus loopback transport. */
export class SseSubscriber {
  private buffer = "";
  private response: IncomingMessage | undefined;
  private closed = false;
  readonly events: SseEvent[] = [];
  status = 0;

  constructor(
    private readonly port: number,
    private readonly ip: string,
    private readonly onEvent?: (event: SseEvent) => void,
  ) {}

  open(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: this.port,
          method: "GET",
          path: "/api/orders/stream",
          headers: { "X-Forwarded-For": this.ip, Accept: "text/event-stream" },
        },
        (res) => {
          this.status = res.statusCode ?? 0;
          this.response = res;
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => this.consume(chunk));
          res.on("end", () => {
            this.closed = true;
          });
          resolve();
        },
      );
      req.once("error", reject);
      req.end();
    });
  }

  private consume(chunk: string): void {
    const atMs = performance.now();
    this.buffer += chunk;
    let boundary = this.buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const frame = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      const event = parseFrame(atMs, frame);
      if (event !== undefined) {
        this.events.push(event);
        this.onEvent?.(event);
      }
      boundary = this.buffer.indexOf("\n\n");
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }

  close(): void {
    this.closed = true;
    this.response?.destroy();
  }
}

function parseFrame(atMs: number, frame: string): SseEvent | undefined {
  let name = "message";
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith(":")) return undefined;
    if (line.startsWith("event: ")) name = line.slice("event: ".length);
    else if (line.startsWith("data: ")) data.push(line.slice("data: ".length));
  }
  if (data.length === 0) return undefined;
  return { atMs, name, data: data.join("\n") };
}
