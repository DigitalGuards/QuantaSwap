// Client for the coordination-only order book service. Nothing returned by
// this API is trusted for fund movement: recipients, amounts and timeouts
// are always re-verified against on-chain HTLC state before acting.

import { ORDERBOOK_API, type EthAssetSymbol } from "../config";
import type { ActiveSwap, Direction } from "./activeSwap";

export type OrderStatus = "open" | "accepted" | "locking" | "cancelled";

export interface OrderView {
  id: string;
  direction: Direction;
  /** ETH-leg asset symbol; absent on books/rows predating stable pairs
   *  and means "ETH". Untrusted like every book field: clients resolve
   *  the symbol against their own registry and verify the escrowed token
   *  address on-chain. */
  asset?: EthAssetSymbol;
  /** Base units of the maker leg's asset (QRL wei or ETH-leg asset units
   *  per `asset` and direction), decimal string. */
  fromAmount: string;
  /** Base units of the taker leg's asset, decimal string. */
  toAmount: string;
  makerEthAccount: string;
  makerQrlAccount: string;
  status: OrderStatus;
  takerEthAccount: string | null;
  takerQrlAccount: string | null;
  hashlock: string | null;
  initiatorTimeout: number | null;
  responderTimeout: number | null;
  /** The taker released this take; the maker should not (further) commit
   *  funds. Optional for books predating the flag. */
  released?: boolean;
  /** The maker's client heartbeated recently, so a take can actually
   *  proceed. Optional for books predating it. */
  makerSeen?: boolean;
  createdAt: number;
  updatedAt: number;
}

export class OrderGoneError extends Error {}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${ORDERBOOK_API}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = (await res.json().catch(() => ({}))) as { error?: string };
  if (res.status === 404) throw new OrderGoneError(payload.error ?? "order not found");
  if (!res.ok) throw new Error(payload.error ?? `order book request failed (HTTP ${res.status})`);
  return payload as T;
}

export const listOrders = async (): Promise<OrderView[]> =>
  (await api<{ orders: OrderView[] }>("GET", "/orders")).orders;

export const getOrder = async (id: string): Promise<OrderView> =>
  (await api<{ order: OrderView }>("GET", `/orders/${id}`)).order;

export const createOrder = async (body: {
  direction: Direction;
  /** ETH-leg asset symbol for the pair this order trades. */
  asset: EthAssetSymbol;
  fromAmount: string;
  toAmount: string;
  makerEthAccount: string;
  makerQrlAccount: string;
}): Promise<{ order: OrderView; makerToken: string }> => api("POST", "/orders", body);

export const acceptOrder = async (
  id: string,
  body: { takerEthAccount: string; takerQrlAccount: string },
): Promise<{ order: OrderView; takerToken: string }> =>
  api("POST", `/orders/${id}/accept`, body);

/** Take by terms rather than by id: atomically fills the best open order
 *  where the taker pays at most `maxPay` (the order's toAmount) and
 *  receives at least `minReceive` (the order's fromAmount). Two takers
 *  racing for the same row both fill while depth exists, and a stale
 *  click can only fill at the terms the taker saw or better. */
export const takeOrder = async (body: {
  direction: Direction;
  /** ETH-leg asset of the pair to match; orders of other assets never
   *  fill this request even when their raw amounts satisfy the bounds. */
  asset: EthAssetSymbol;
  maxPay: string;
  minReceive: string;
  takerEthAccount: string;
  takerQrlAccount: string;
}): Promise<{ order: OrderView; takerToken: string }> => api("POST", "/orders/take", body);

/** Maker liveness ping; keeps the listing visible as takeable. */
export const heartbeatOrder = async (id: string, token: string): Promise<OrderView> =>
  (await api<{ order: OrderView }>("POST", `/orders/${id}/heartbeat`, { token })).order;

/** Live book subscription (SSE). The server pushes the full open list on
 *  connect and on every change; the browser's EventSource reconnects on
 *  its own. Callers keep a slow poll as fallback via `isLive()`. */
export function openBookStream(onBook: (orders: OrderView[]) => void): {
  isLive: () => boolean;
  close: () => void;
} {
  const es = new EventSource(`${ORDERBOOK_API}/orders/stream`);
  es.addEventListener("book", (event) => {
    try {
      onBook((JSON.parse((event as MessageEvent<string>).data) as { orders: OrderView[] }).orders);
    } catch {
      // malformed frame; the next push or the poll fallback recovers
    }
  });
  return {
    isLive: () => es.readyState === EventSource.OPEN,
    close: () => es.close(),
  };
}

/** Taker walk-away. Before the maker locks, the order returns to the book;
 *  after, it only stops counting against the taker's per-IP take slots.
 *  Purely book-keeping either way, so callers may fire and forget. */
export const releaseOrder = async (id: string, token: string): Promise<OrderView> =>
  (await api<{ order: OrderView }>("POST", `/orders/${id}/release`, { token })).order;

/** Fire-and-forget release of a taker's reservation when they abandon or
 *  finish a swap; no-op for makers/sandbox. Funds are always governed
 *  on-chain, so failures are fine to ignore. */
export const releaseTake = (s: ActiveSwap | null): void => {
  if (s && s.role === "taker" && s.orderId && s.takerToken) {
    void releaseOrder(s.orderId, s.takerToken).catch(() => undefined);
  }
};

export const announceHashlock = async (
  id: string,
  body: { token: string; hashlock: string; initiatorTimeout: number; responderTimeout: number },
): Promise<OrderView> =>
  (await api<{ order: OrderView }>("POST", `/orders/${id}/hashlock`, body)).order;

export const cancelOrder = async (id: string, token: string): Promise<OrderView> =>
  (await api<{ order: OrderView }>("POST", `/orders/${id}/cancel`, { token })).order;
