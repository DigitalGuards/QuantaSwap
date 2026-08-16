// Endpoint-bound transport for one order book origin. Authentication and
// mirror reconciliation live above this layer so private capabilities and
// mutations always stay attached to the origin selected by the browser.

import type { OrderbookMirror } from "../config";
import type { Direction } from "./activeSwap";
import type { EthAssetSymbol } from "./assetRegistry";
import type {
  CreateOrderBody,
  MakerOrderAuthV1,
  OrderView,
} from "./orderbook";
import type {
  SignedCancelV1,
  SignedFillIntentV1,
  SignedFillV1,
} from "./orderSigning";
import { verifyOrderCapabilities } from "./orderSigning";

export class OrderGoneError extends Error {}

export interface FillIntentView extends SignedFillIntentV1 {
  intentDigest: string;
  receivedAt: number;
}

export interface SignedOrderCreateRequest {
  order: CreateOrderBody;
  auth: MakerOrderAuthV1;
  makerToken: string;
  shareToken?: string;
}

export type PortableReleaseRequest =
  | {
      releaseSecret: string;
      fillDigest: string;
      intentDigest?: never;
      shareToken?: string;
    }
  | {
      releaseSecret: string;
      intentDigest: string;
      fillDigest?: never;
      shareToken?: string;
    };

export interface OrderbookEventStream {
  isLive: () => boolean;
  close: () => void;
}

export interface EventSourcePort {
  readonly readyState: number;
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void;
  close(): void;
}

export interface OrderbookClientOptions {
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  eventSource?: (url: string) => EventSourcePort;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_API_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_LIST_ORDERS = 200;
const ID_RE = /^[0-9a-z-]{1,128}$/;
const ETH_ADDR_RE = /^0x[0-9a-f]{40}$/;
const QRL_ADDR_RE = /^Q[0-9a-f]{40}$/;
const AMOUNT_RE = /^(?:0|[1-9][0-9]{0,29})$/;
const BYTES32_RE = /^0x[0-9a-f]{64}$/;

const defaultEventSource = (url: string): EventSourcePort =>
  new EventSource(url) as unknown as EventSourcePort;

function privateHeader(shareToken: string | undefined): Record<string, string> | undefined {
  return shareToken === undefined ? undefined : { "X-Share-Token": shareToken };
}

async function boundedJson(response: Response): Promise<unknown> {
  const advertisedLength = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(advertisedLength) && advertisedLength > MAX_API_RESPONSE_BYTES) {
    throw new Error("order book response exceeds the size limit");
  }
  if (response.body === null) return {};

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_API_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("order book response exceeds the size limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

function optionalCanonicalAddress(
  value: unknown,
  pattern: RegExp,
): boolean {
  return value === undefined || (typeof value === "string" && pattern.test(value));
}

function nullableCanonicalAddress(value: unknown, pattern: RegExp): boolean {
  return value === null || (typeof value === "string" && pattern.test(value));
}

function nullableSafeUint(value: unknown): boolean {
  return value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}

function isOrderView(value: unknown): value is OrderView {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const order = value as Record<string, unknown>;
  return (
    typeof order["id"] === "string" &&
    ID_RE.test(order["id"]) &&
    (order["direction"] === "eth->qrl" || order["direction"] === "qrl->eth") &&
    (order["asset"] === undefined ||
      order["asset"] === "ETH" ||
      order["asset"] === "USDC" ||
      order["asset"] === "tUSDT") &&
    typeof order["fromAmount"] === "string" &&
    AMOUNT_RE.test(order["fromAmount"]) &&
    typeof order["toAmount"] === "string" &&
    AMOUNT_RE.test(order["toAmount"]) &&
    typeof order["makerEthAccount"] === "string" &&
    ETH_ADDR_RE.test(order["makerEthAccount"]) &&
    typeof order["makerQrlAccount"] === "string" &&
    QRL_ADDR_RE.test(order["makerQrlAccount"]) &&
    (order["status"] === "open" ||
      order["status"] === "accepted" ||
      order["status"] === "locking" ||
      order["status"] === "cancelled") &&
    nullableCanonicalAddress(order["takerEthAccount"], ETH_ADDR_RE) &&
    nullableCanonicalAddress(order["takerQrlAccount"], QRL_ADDR_RE) &&
    (order["hashlock"] === null ||
      (typeof order["hashlock"] === "string" && BYTES32_RE.test(order["hashlock"]))) &&
    nullableSafeUint(order["initiatorTimeout"]) &&
    nullableSafeUint(order["responderTimeout"]) &&
    (order["visibility"] === undefined ||
      order["visibility"] === "public" ||
      order["visibility"] === "private") &&
    optionalCanonicalAddress(order["allowedTakerEth"], ETH_ADDR_RE) &&
    optionalCanonicalAddress(order["allowedTakerQrl"], QRL_ADDR_RE) &&
    typeof order["createdAt"] === "number" &&
    Number.isSafeInteger(order["createdAt"]) &&
    order["createdAt"] >= 0 &&
    typeof order["updatedAt"] === "number" &&
    Number.isSafeInteger(order["updatedAt"]) &&
    order["updatedAt"] >= 0 &&
    (order["released"] === undefined || typeof order["released"] === "boolean") &&
    (order["makerSeen"] === undefined || typeof order["makerSeen"] === "boolean") &&
    (order["prelocked"] === undefined || typeof order["prelocked"] === "boolean") &&
    (order["makerAuth"] === undefined ||
      (typeof order["makerAuth"] === "object" &&
        order["makerAuth"] !== null &&
        !Array.isArray(order["makerAuth"])))
  );
}

function parseOrderList(raw: unknown): OrderView[] {
  if (!Array.isArray(raw)) throw new Error("order book returned an invalid order list");
  if (raw.length > MAX_LIST_ORDERS) {
    throw new Error("order book returned too many orders");
  }
  return raw.filter(isOrderView);
}

export class OrderbookClient {
  readonly bookId: string;
  readonly apiBase: string;

  private readonly requestFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  private readonly makeEventSource: (url: string) => EventSourcePort;
  private readonly timeoutMs: number;

  constructor(mirror: OrderbookMirror, options: OrderbookClientOptions = {}) {
    this.bookId = mirror.id;
    this.apiBase = mirror.apiBase;
    this.requestFetch = options.fetch ?? fetch;
    this.makeEventSource = options.eventSource ?? defaultEventSource;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private async api<T>(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<T> {
    const response = await this.requestFetch(`${this.apiBase}${path}`, {
      method,
      redirect: "error",
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      signal: AbortSignal.timeout(this.timeoutMs),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let payload: unknown;
    const contentType = response.headers
      .get("Content-Type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    if (contentType !== "application/json") {
      if (response.ok) {
        throw new Error("order book response must use application/json");
      }
      payload = {};
    } else {
      try {
        payload = await boundedJson(response);
      } catch (error) {
        if (response.ok) throw error;
        payload = {};
      }
    }
    const errorPayload =
      typeof payload === "object" && payload !== null && !Array.isArray(payload)
        ? (payload as { error?: unknown })
        : {};
    const error =
      typeof errorPayload.error === "string" ? errorPayload.error : undefined;
    if (response.status === 404) {
      throw new OrderGoneError(error ?? "order not found");
    }
    if (!response.ok) {
      throw new Error(error ?? `order book request failed (HTTP ${response.status})`);
    }
    return payload as T;
  }

  async list(): Promise<OrderView[]> {
    const payload = await this.api<{ orders?: unknown }>("GET", "/orders");
    return parseOrderList(payload.orders);
  }

  async get(id: string, shareToken?: string): Promise<OrderView> {
    return (
      await this.api<{ order: OrderView }>(
        "GET",
        `/orders/${encodeURIComponent(id)}`,
        undefined,
        privateHeader(shareToken),
      )
    ).order;
  }

  async create(
    body: CreateOrderBody,
  ): Promise<{ order: OrderView; makerToken: string; shareToken?: string }> {
    return this.api("POST", "/orders", body);
  }

  async createSigned(
    request: SignedOrderCreateRequest,
  ): Promise<{ order: OrderView }> {
    if (
      !verifyOrderCapabilities(
        request.order,
        request.auth,
        request.makerToken,
        request.shareToken,
      )
    ) {
      throw new Error("signed order capabilities do not match their commitments");
    }
    return this.api("POST", "/orders/signed", request);
  }

  async accept(
    id: string,
    body: { takerEthAccount: string; takerQrlAccount: string; shareToken?: string },
  ): Promise<{ order: OrderView; takerToken: string }> {
    return this.api("POST", `/orders/${encodeURIComponent(id)}/accept`, body);
  }

  async take(body: {
    direction: Direction;
    asset: EthAssetSymbol;
    maxPay: string;
    minReceive: string;
    takerEthAccount: string;
    takerQrlAccount: string;
  }): Promise<{ order: OrderView; takerToken: string }> {
    return this.api("POST", "/orders/take", body);
  }

  async heartbeat(id: string, token: string): Promise<OrderView> {
    return (
      await this.api<{ order: OrderView }>(
        "POST",
        `/orders/${encodeURIComponent(id)}/heartbeat`,
        { token },
      )
    ).order;
  }

  async submitIntent(
    id: string,
    signed: SignedFillIntentV1,
    shareToken?: string,
  ): Promise<FillIntentView> {
    return (
      await this.api<{ intent: FillIntentView }>(
        "POST",
        `/orders/${encodeURIComponent(id)}/intents`,
        signed,
        privateHeader(shareToken),
      )
    ).intent;
  }

  async intents(id: string, makerToken?: string): Promise<FillIntentView[]> {
    const headers =
      makerToken === undefined ? undefined : { "X-Maker-Token": makerToken };
    return (
      await this.api<{ intents: FillIntentView[] }>(
        "GET",
        `/orders/${encodeURIComponent(id)}/intents`,
        undefined,
        headers,
      )
    ).intents;
  }

  async fill(
    id: string,
    signed: SignedFillV1,
    selected: SignedFillIntentV1,
    makerToken?: string,
  ): Promise<OrderView> {
    return (
      await this.api<{ order: OrderView }>("POST", `/orders/${encodeURIComponent(id)}/fill`, {
        ...signed,
        intent: selected.intent,
        intentAuth: selected.auth,
        ...(makerToken === undefined ? {} : { token: makerToken }),
      })
    ).order;
  }

  async cancelSigned(
    id: string,
    signed: SignedCancelV1,
    makerToken?: string,
  ): Promise<OrderView> {
    return (
      await this.api<{ order: OrderView }>(
        "POST",
        `/orders/${encodeURIComponent(id)}/cancel/signed`,
        {
          ...signed,
          ...(makerToken === undefined ? {} : { token: makerToken }),
        },
      )
    ).order;
  }

  async release(id: string, token: string): Promise<OrderView> {
    return (
      await this.api<{ order: OrderView }>(
        "POST",
        `/orders/${encodeURIComponent(id)}/release`,
        { token },
      )
    ).order;
  }

  async releasePortable(id: string, request: PortableReleaseRequest): Promise<OrderView> {
    return (
      await this.api<{ order: OrderView }>(
        "POST",
        `/orders/${encodeURIComponent(id)}/release`,
        request,
      )
    ).order;
  }

  async announceHashlock(
    id: string,
    body: { token: string; hashlock: string; initiatorTimeout: number; responderTimeout: number },
  ): Promise<OrderView> {
    return (
      await this.api<{ order: OrderView }>(
        "POST",
        `/orders/${encodeURIComponent(id)}/hashlock`,
        body,
      )
    ).order;
  }

  async cancel(id: string, token: string): Promise<OrderView> {
    return (
      await this.api<{ order: OrderView }>(
        "POST",
        `/orders/${encodeURIComponent(id)}/cancel`,
        { token },
      )
    ).order;
  }

  openBookStream(onBook: (orders: OrderView[]) => void): OrderbookEventStream {
    const eventSource = this.makeEventSource(`${this.apiBase}/orders/stream`);
    eventSource.addEventListener("book", (event) => {
      try {
        if (event.data.length > MAX_API_RESPONSE_BYTES) return;
        const payload = JSON.parse(event.data) as { orders?: unknown };
        onBook(parseOrderList(payload.orders));
      } catch {
        // A full snapshot follows every real book change. The caller also
        // keeps a poll fallback, so one malformed frame can be discarded.
      }
    });
    return {
      isLive: () => eventSource.readyState === 1,
      close: () => eventSource.close(),
    };
  }
}
