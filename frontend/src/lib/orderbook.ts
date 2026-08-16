// Client for the coordination-only order book service. Nothing returned by
// this API is trusted for fund movement: recipients, amounts and timeouts
// are always re-verified against on-chain HTLC state before acting.

import {
  CLAIM_MARGIN_S,
  ORDERBOOK_API,
  ethAssetSymbolOrNull,
  type EthAssetSymbol,
} from "../config";
import type { ActiveSwap, Direction, MyOrderRef } from "./activeSwap";

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
  /** Private orders are excluded from the book and take-by-terms and are
   *  reachable only by id with the share token. Optional for books
   *  predating the feature (absent means public). */
  visibility?: "public" | "private";
  /** Taker restriction on a private order; informational here (the book
   *  enforces it on accept, the maker's client re-verifies regardless). */
  allowedTakerEth?: string;
  allowedTakerQrl?: string;
  /** Pre-funded listing: the maker escrowed on-chain at post time, so
   *  `hashlock`/`initiatorTimeout` are set while still open. A claim, not
   *  a fact: clients verify the escrow on-chain before trusting it. */
  prelocked?: boolean;
  createdAt: number;
  updatedAt: number;
  /** Portable maker proof on OrderV1 rows. Legacy/local-liquidity rows
   *  created through the compatibility endpoint do not carry one. */
  makerAuth?: MakerOrderAuthV1;
}

export type OrderSigningScheme = "qrl-sign-typed-v1" | "qrl-eip712-v4";

export interface MakerOrderAuthV1 {
  version: "1";
  scheme: OrderSigningScheme;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
  signature: string;
  publicKey: string;
  descriptor: string;
}

interface BaseOrderTerms {
  direction: Direction;
  asset: EthAssetSymbol;
  fromAmount: string;
  toAmount: string;
}

export type BoundOrderTerms = BaseOrderTerms &
  (
    | {
        prelocked: false;
        hashlock: null;
        initiatorTimeout: null;
      }
    | {
        prelocked: true;
        hashlock: string;
        initiatorTimeout: number;
      }
  );

export interface ExpectedTakerAccounts {
  takerEthAccount: string;
  takerQrlAccount: string;
}

export interface AnnouncedOrderTerms {
  hashlock: string;
  initiatorTimeout: number;
  responderTimeout: number;
}

const AMOUNT_RE = /^(0|[1-9][0-9]{0,29})$/;
const HASHLOCK_RE = /^0x[0-9a-f]{64}$/;
const TERMS_CHANGED = "The order book returned different swap semantics; the take was abandoned.";

const sameAccount = (left: string | null, right: string): boolean =>
  typeof left === "string" && left.toLowerCase() === right.toLowerCase();

/** Parse the untrusted book's economic terms into a bounded runtime shape. */
function baseOrderTerms(order: OrderView): BaseOrderTerms {
  if (order.direction !== "eth->qrl" && order.direction !== "qrl->eth") {
    throw new Error(TERMS_CHANGED);
  }
  const asset = ethAssetSymbolOrNull(order.asset ?? "ETH");
  if (
    asset === null ||
    !AMOUNT_RE.test(order.fromAmount) ||
    !AMOUNT_RE.test(order.toAmount) ||
    BigInt(order.fromAmount) === 0n ||
    BigInt(order.toAmount) === 0n
  ) {
    throw new Error(TERMS_CHANGED);
  }
  return {
    direction: order.direction,
    asset,
    fromAmount: order.fromAmount,
    toAmount: order.toAmount,
  };
}

/** Parse an open/accepted row, including its exact prelock field shape. */
function boundOrderTerms(order: OrderView): BoundOrderTerms {
  const base = baseOrderTerms(order);
  const prelocked = order.prelocked === true;
  if (prelocked) {
    if (
      typeof order.hashlock !== "string" ||
      !HASHLOCK_RE.test(order.hashlock) ||
      typeof order.initiatorTimeout !== "number" ||
      !Number.isSafeInteger(order.initiatorTimeout) ||
      order.responderTimeout !== null
    ) {
      throw new Error(TERMS_CHANGED);
    }
    return {
      ...base,
      prelocked: true,
      hashlock: order.hashlock,
      initiatorTimeout: order.initiatorTimeout,
    };
  }

  // Classic rows have no H/T1/T2 until the maker announces. Silently
  // discarding unexpected values here would let a response smuggle in a
  // different protocol mode while still passing the economic checks.
  if (
    order.hashlock !== null ||
    order.initiatorTimeout !== null ||
    order.responderTimeout !== null
  ) {
    throw new Error(TERMS_CHANGED);
  }
  return {
    ...base,
    prelocked: false,
    hashlock: null,
    initiatorTimeout: null,
  };
}

/**
 * Re-check an accept/take response against the exact row the user approved.
 * A take-by-terms response may improve the two numeric bounds and may name a
 * different maker, but it may never change direction, asset, or prelock
 * semantics. An accept-by-id response must preserve the entire displayed row.
 */
export function acceptedOrderTerms(
  displayed: OrderView,
  accepted: OrderView,
  expectedAsset: EthAssetSymbol,
  mode: "same-order" | "same-or-better",
  expectedTaker: ExpectedTakerAccounts,
): BoundOrderTerms {
  const shown = boundOrderTerms(displayed);
  const filled = boundOrderTerms(accepted);
  const sameSemantics =
    shown.asset === expectedAsset &&
    filled.asset === expectedAsset &&
    filled.direction === shown.direction &&
    filled.prelocked === shown.prelocked &&
    (!shown.prelocked ||
      (filled.hashlock === shown.hashlock &&
        filled.initiatorTimeout === shown.initiatorTimeout));
  const sameOrder =
    accepted.id === displayed.id &&
    accepted.makerEthAccount.toLowerCase() === displayed.makerEthAccount.toLowerCase() &&
    accepted.makerQrlAccount.toLowerCase() === displayed.makerQrlAccount.toLowerCase();
  const sameTaker =
    sameAccount(accepted.takerEthAccount, expectedTaker.takerEthAccount) &&
    sameAccount(accepted.takerQrlAccount, expectedTaker.takerQrlAccount);
  const validAmounts =
    mode === "same-order"
      ? filled.fromAmount === shown.fromAmount && filled.toAmount === shown.toAmount
      : BigInt(filled.fromAmount) >= BigInt(shown.fromAmount) &&
        BigInt(filled.toAmount) <= BigInt(shown.toAmount);

  if (
    displayed.status !== "open" ||
    accepted.status !== "accepted" ||
    !sameSemantics ||
    !sameTaker ||
    !validAmounts ||
    (mode === "same-order" && !sameOrder)
  ) {
    throw new Error(TERMS_CHANGED);
  }
  return { ...filled, direction: shown.direction, asset: expectedAsset };
}

/**
 * The maker's capability is not enough to authenticate economic terms. Those
 * terms must match the local handle written when the maker posted the order.
 */
export function assertMakerOrderTerms(
  local: MyOrderRef,
  current: OrderView,
): asserts local is MyOrderRef & {
  direction: Direction;
  fromAmount: string;
  toAmount: string;
} {
  if (local.direction === null || local.fromAmount === null || local.toAmount === null) {
    throw new Error("This saved order predates local term binding; cancel or release it and relist.");
  }
  const terms = baseOrderTerms(current);
  const expectedPrelocked = local.prelock !== null;
  const expectedLeg = local.direction === "eth->qrl" ? "eth" : "qrl";
  const accepted = current.status === "accepted";
  const locking = current.status === "locking";
  const validLockingTimes =
    typeof current.hashlock === "string" &&
    HASHLOCK_RE.test(current.hashlock) &&
    typeof current.initiatorTimeout === "number" &&
    Number.isSafeInteger(current.initiatorTimeout) &&
    typeof current.responderTimeout === "number" &&
    Number.isSafeInteger(current.responderTimeout);
  const validClassicShape =
    (accepted &&
      current.hashlock === null &&
      current.initiatorTimeout === null &&
      current.responderTimeout === null) ||
    (locking && validLockingTimes);
  const validPrelockShape =
    current.prelocked === true &&
    typeof current.hashlock === "string" &&
    HASHLOCK_RE.test(current.hashlock) &&
    typeof current.initiatorTimeout === "number" &&
    Number.isSafeInteger(current.initiatorTimeout) &&
    ((accepted && current.responderTimeout === null) ||
      (locking &&
        typeof current.responderTimeout === "number" &&
        Number.isSafeInteger(current.responderTimeout)));
  if (
    (!accepted && !locking) ||
    current.id !== local.id ||
    terms.direction !== local.direction ||
    terms.asset !== local.asset ||
    terms.fromAmount !== local.fromAmount ||
    terms.toAmount !== local.toAmount ||
    (current.prelocked === true) !== expectedPrelocked ||
    (expectedPrelocked ? !validPrelockShape : !validClassicShape) ||
    (local.prelock !== null &&
      (local.prelock.leg !== expectedLeg ||
        current.hashlock !== local.prelock.hashlock ||
        current.initiatorTimeout !== local.prelock.initiatorTimeout))
  ) {
    throw new Error("The order book changed your locally anchored swap terms; refusing to match.");
  }
}

/** Reusing a persisted preimage is safe only for the locally bound order. */
export function assertStoredMakerSwapTerms(local: MyOrderRef, stored: ActiveSwap): void {
  if (
    local.direction === null ||
    local.fromAmount === null ||
    local.toAmount === null ||
    stored.role !== "maker" ||
    stored.termsBindingVersion !== 1 ||
    stored.orderId !== local.id ||
    stored.direction !== local.direction ||
    stored.ethAsset !== local.asset ||
    stored.fromAmount !== local.fromAmount ||
    stored.toAmount !== local.toAmount ||
    Boolean(stored.prelocked) !== (local.prelock !== null) ||
    (local.prelock !== null &&
      (stored.hashlock !== local.prelock.hashlock ||
        stored.initiatorTimeout !== local.prelock.initiatorTimeout))
  ) {
    throw new Error("The saved swap does not match your locally anchored order; refusing to continue.");
  }
}

/** Bind every order-book field used during maker announce or recovery to
 *  the locally persisted order and swap before any capability is used. */
export function assertMakerOrderProgress(
  local: MyOrderRef,
  stored: ActiveSwap,
  current: OrderView,
): void {
  assertStoredMakerSwapTerms(local, stored);
  assertMakerOrderTerms(local, current);
  const accountsMatch =
    current.makerEthAccount.toLowerCase() === stored.makerEthAccount.toLowerCase() &&
    current.makerQrlAccount.toLowerCase() === stored.makerQrlAccount.toLowerCase() &&
    sameAccount(current.takerEthAccount, stored.takerEthAccount) &&
    sameAccount(current.takerQrlAccount, stored.takerQrlAccount);
  const announcementMatches =
    current.status !== "locking" ||
    (current.hashlock === stored.hashlock &&
      current.initiatorTimeout === stored.initiatorTimeout &&
      current.responderTimeout === stored.responderTimeout);
  if (!accountsMatch || !announcementMatches) {
    throw new Error("The order book changed the matched parties or announcement; refusing to continue.");
  }
}

/** Validate the maker's locking announcement against the taker's accepted
 *  snapshot before copying H/T1/T2 into active swap state. */
export function announcedOrderTerms(
  stored: ActiveSwap,
  current: OrderView,
  now: number,
): AnnouncedOrderTerms {
  const terms = baseOrderTerms(current);
  const anchor = stored.acceptedPrelock;
  const prelockMatches =
    stored.prelocked === true
      ? current.prelocked === true &&
        anchor !== null &&
        anchor !== undefined &&
        current.hashlock === anchor.hashlock &&
        current.initiatorTimeout === anchor.initiatorTimeout
      : current.prelocked !== true && (anchor === null || anchor === undefined);
  const accountsMatch =
    current.makerEthAccount.toLowerCase() === stored.makerEthAccount.toLowerCase() &&
    current.makerQrlAccount.toLowerCase() === stored.makerQrlAccount.toLowerCase() &&
    sameAccount(current.takerEthAccount, stored.takerEthAccount) &&
    sameAccount(current.takerQrlAccount, stored.takerQrlAccount);
  if (
    stored.termsBindingVersion !== 1 ||
    stored.orderId === null ||
    current.id !== stored.orderId ||
    current.status !== "locking" ||
    terms.direction !== stored.direction ||
    terms.asset !== stored.ethAsset ||
    terms.fromAmount !== stored.fromAmount ||
    terms.toAmount !== stored.toAmount ||
    !accountsMatch ||
    !prelockMatches ||
    typeof current.hashlock !== "string" ||
    !HASHLOCK_RE.test(current.hashlock) ||
    typeof current.initiatorTimeout !== "number" ||
    !Number.isSafeInteger(current.initiatorTimeout) ||
    typeof current.responderTimeout !== "number" ||
    !Number.isSafeInteger(current.responderTimeout) ||
    current.responderTimeout <= now + 600 ||
    current.initiatorTimeout < current.responderTimeout + CLAIM_MARGIN_S
  ) {
    throw new Error("The maker announced unsafe or changed swap parameters.");
  }
  return {
    hashlock: current.hashlock,
    initiatorTimeout: current.initiatorTimeout,
    responderTimeout: current.responderTimeout,
  };
}

export class OrderGoneError extends Error {}

async function api<T>(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<T> {
  const res = await fetch(`${ORDERBOOK_API}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = (await res.json().catch(() => ({}))) as { error?: string };
  if (res.status === 404) throw new OrderGoneError(payload.error ?? "order not found");
  if (!res.ok) throw new Error(payload.error ?? `order book request failed (HTTP ${res.status})`);
  return payload as T;
}

export const listOrders = async (): Promise<OrderView[]> =>
  (await api<{ orders: OrderView[] }>("GET", "/orders")).orders;

/** Private orders demand the share token (sent as a header so it never
 *  lands in server logs; the browser keeps it in the URL fragment, which
 *  never leaves the page) and 404 without it. */
export const getOrder = async (id: string, shareToken?: string): Promise<OrderView> =>
  (
    await api<{ order: OrderView }>(
      "GET",
      `/orders/${id}`,
      undefined,
      shareToken === undefined ? undefined : { "X-Share-Token": shareToken },
    )
  ).order;

export interface CreateOrderBody {
  direction: Direction;
  /** ETH-leg asset symbol for the pair this order trades. */
  asset: EthAssetSymbol;
  fromAmount: string;
  toAmount: string;
  makerEthAccount: string;
  makerQrlAccount: string;
  /** Private orders skip the public book; the response carries the share
   *  token whose URL the maker hands to the counterparty. */
  visibility?: "public" | "private";
  allowedTakerEth?: string;
  allowedTakerQrl?: string;
  /** Pre-funded listing: the open lock is already on-chain under this
   *  hashlock with this fixed T1; announce later echoes both verbatim. */
  prelock?: { hashlock: string; initiatorTimeout: number };
}

/** Legacy/local-liquidity compatibility path. Interactive makers use
 *  createSignedOrder so their listing can be authenticated by mirrors. */
export const createOrder = async (
  body: CreateOrderBody,
): Promise<{ order: OrderView; makerToken: string; shareToken?: string }> =>
  api("POST", "/orders", body);

export const createSignedOrder = async (
  order: CreateOrderBody,
  auth: MakerOrderAuthV1,
): Promise<{ order: OrderView; makerToken: string; shareToken?: string }> =>
  api("POST", "/orders/signed", { order, auth });

export const acceptOrder = async (
  id: string,
  body: { takerEthAccount: string; takerQrlAccount: string; shareToken?: string },
): Promise<{ order: OrderView; takerToken: string }> =>
  api("POST", `/orders/${id}/accept`, body);

/** Fragment carrying a private order's share token on /o/<id> links. In
 *  the fragment (never the query string) so it stays out of every access
 *  log between the browser and the SPA. */
export const shareFragment = (token: string): string => `#k=${token}`;

export const parseShareToken = (hash: string): string | null => {
  const m = /^#k=([0-9a-f]{64})$/.exec(hash);
  return m?.[1] ?? null;
};

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
