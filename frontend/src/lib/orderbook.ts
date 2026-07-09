// Client for the coordination-only order book service. Nothing returned by
// this API is trusted for fund movement: recipients, amounts and timeouts
// are always re-verified against on-chain HTLC state before acting.

import { ORDERBOOK_API } from "../config";
import type { Direction } from "./activeSwap";

export type OrderStatus = "open" | "accepted" | "locking" | "cancelled";

export interface OrderView {
  id: string;
  direction: Direction;
  fromAmount: string;
  toAmount: string;
  makerEthAccount: string;
  makerQrlAccount: string;
  status: OrderStatus;
  takerEthAccount: string | null;
  takerQrlAccount: string | null;
  hashlock: string | null;
  initiatorTimeout: number | null;
  responderTimeout: number | null;
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

/** Taker walk-away. Before the maker locks, the order returns to the book;
 *  after, it only stops counting against the taker's per-IP take slots.
 *  Purely book-keeping either way, so callers may fire and forget. */
export const releaseOrder = async (id: string, token: string): Promise<OrderView> =>
  (await api<{ order: OrderView }>("POST", `/orders/${id}/release`, { token })).order;

export const announceHashlock = async (
  id: string,
  body: { token: string; hashlock: string; initiatorTimeout: number; responderTimeout: number },
): Promise<OrderView> =>
  (await api<{ order: OrderView }>("POST", `/orders/${id}/hashlock`, body)).order;

export const cancelOrder = async (id: string, token: string): Promise<OrderView> =>
  (await api<{ order: OrderView }>("POST", `/orders/${id}/cancel`, { token })).order;
