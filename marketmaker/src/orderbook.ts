// Order book API client, mirroring frontend/src/lib/orderbook.ts. Nothing
// returned here is trusted for fund movement.

import type { Direction } from "./policy.js";

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
  /** The taker released this take (walked away with an authorized
   *  release); optional for books predating the flag. */
  released?: boolean;
  /** The maker heartbeated recently; optional for books predating it. */
  makerSeen?: boolean;
  createdAt: number;
  updatedAt: number;
}

export class OrderGoneError extends Error {}

export class OrderBookClient {
  constructor(
    private readonly base: string,
    /** Per-call deadline. The tick calls the book FIRST every order, so a
     *  stalling or hostile book must never be able to hang here. */
    private readonly timeoutMs = 20_000,
  ) {}

  private async api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const payload = (await res.json().catch(() => ({}))) as { error?: string };
    if (res.status === 404) throw new OrderGoneError(payload.error ?? "order not found");
    if (!res.ok) {
      throw new Error(payload.error ?? `order book request failed (HTTP ${res.status})`);
    }
    return payload as T;
  }

  async get(id: string): Promise<OrderView> {
    return (await this.api<{ order: OrderView }>("GET", `/orders/${id}`)).order;
  }

  async create(body: {
    direction: Direction;
    fromAmount: string;
    toAmount: string;
    makerEthAccount: string;
    makerQrlAccount: string;
  }): Promise<{ order: OrderView; makerToken: string }> {
    return this.api("POST", "/orders", body);
  }

  async announceHashlock(
    id: string,
    body: { token: string; hashlock: string; initiatorTimeout: number; responderTimeout: number },
  ): Promise<OrderView> {
    return (await this.api<{ order: OrderView }>("POST", `/orders/${id}/hashlock`, body)).order;
  }

  async cancel(id: string, token: string): Promise<OrderView> {
    return (await this.api<{ order: OrderView }>("POST", `/orders/${id}/cancel`, { token })).order;
  }

  /** Maker liveness ping; keeps our listings in the matchable set. */
  async heartbeat(id: string, token: string): Promise<OrderView> {
    return (await this.api<{ order: OrderView }>("POST", `/orders/${id}/heartbeat`, { token }))
      .order;
  }
}
