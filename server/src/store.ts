// Order store for protocol-mode swaps. Coordination only, never custody:
// the service carries order parameters, the taker's addresses and the
// maker's hashlock announcement. Every fact that moves funds is verified
// on-chain by both clients before they act, so a malicious or corrupted
// order book can waste time but cannot redirect a swap.

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { QRL_BOUNDS, isKnownAsset, requireAsset, type AmountBounds, type AssetSymbol } from "./assets.js";
import { ApiError } from "./errors.js";

export { ApiError } from "./errors.js";

export type Direction = "eth->qrl" | "qrl->eth";
export type OrderStatus = "open" | "accepted" | "locking" | "cancelled";

export interface Order {
  id: string;
  direction: Direction;
  /** Ethereum-leg asset symbol; the QRL leg is always native QRL (18
   *  decimals). Absent on the wire and in pre-rollout persisted rows
   *  means ETH. */
  asset: AssetSymbol;
  /** Base units of the from-side asset the maker escrows, decimal
   *  string: the order's asset for eth->qrl, QRL wei for qrl->eth. */
  fromAmount: string;
  /** Base units of the to-side asset the maker expects, decimal string:
   *  QRL wei for eth->qrl, the order's asset for qrl->eth. */
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
  /** sha256 of the maker's bearer token; never serialized to clients. */
  makerTokenHash: string;
  /** sha256 of the taker's bearer token (minted on accept, authorizes
   *  release); never serialized to clients. */
  takerTokenHash?: string;
  /** sha256 of the taker's IP, for per-IP take caps; never serialized. */
  acceptorIpHash?: string;
  acceptedAt?: number;
  /** Taker walked away after the maker locked. The order stays `locking`
   *  (chain state governs the funds) but stops counting as an in-progress
   *  take for the taker's IP. */
  releasedAt?: number;
}

export type PublicOrder = Omit<
  Order,
  "makerTokenHash" | "takerTokenHash" | "acceptorIpHash" | "acceptedAt" | "releasedAt"
> & {
  /** The taker released a locking-phase order: the maker should not
   *  (further) commit funds to it. Derived from `releasedAt`. */
  released: boolean;
  /** The maker's client heartbeated recently, so a take can actually
   *  proceed. Presence is in-memory only: a restart grants every loaded
   *  open order one grace window to re-heartbeat. */
  makerSeen: boolean;
};

// Per-asset amount bounds live in assets.ts (mirrored client-side).
const MAX_OPEN_ORDERS = 200;
const OPEN_TTL_S = 48 * 3600;
const ACCEPTED_TTL_S = 3600; // accepted but never locked: cancel
const CANCELLED_TTL_S = 3600;
const LOCKING_LINGER_S = 24 * 3600; // past initiator timeout

/** Maker counts as online for this long after a heartbeat (or create). */
const DEFAULT_PRESENCE_TTL_S = 90;

// Per-IP take caps so one visitor cannot clear the book for everyone
// else. Sized for repeat testnet testing: completed swaps hold their
// concurrency slot until released or past T1 (the book never learns the
// on-chain outcome), so the concurrent cap leaves headroom beyond the
// two side-by-side swaps the book stocks per rung. The daily cap bounds
// slow-drip draining. Bypassable with IP rotation, like every per-IP
// guard here; the goal is fairness for demo traffic, not sybil
// resistance.
const MAX_CONCURRENT_TAKES_PER_IP = 4;
const MAX_TAKES_PER_IP_PER_DAY = 24;
const TAKE_WINDOW_S = 24 * 3600;

const ETH_ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const QRL_ADDR_RE = /^Q[0-9a-fA-F]{40}$/;
const HASHLOCK_RE = /^0x[0-9a-f]{64}$/;
const AMOUNT_RE = /^[0-9]{1,30}$/;

const nowS = (): number => Math.floor(Date.now() / 1000);

const sha256Hex = (s: string): string => createHash("sha256").update(s).digest("hex");

function requireAmount(raw: unknown, field: string, bounds: AmountBounds): string {
  if (typeof raw !== "string" || !AMOUNT_RE.test(raw)) {
    throw new ApiError(400, `${field} must be a decimal base-unit string`);
  }
  const units = BigInt(raw);
  if (units < bounds.minBaseUnits) {
    throw new ApiError(400, `${field} is below the ${bounds.minLabel} minimum`);
  }
  if (units > bounds.maxBaseUnits) throw new ApiError(400, `${field} exceeds the maximum`);
  return units.toString();
}

function requireAddress(raw: unknown, field: string, re: RegExp): string {
  if (typeof raw !== "string" || !re.test(raw)) {
    throw new ApiError(400, `${field} is not a valid address`);
  }
  return raw;
}

function requireDirection(raw: unknown): Direction {
  if (raw !== "eth->qrl" && raw !== "qrl->eth") {
    throw new ApiError(400, "direction must be eth->qrl or qrl->eth");
  }
  return raw;
}

export class OrderStore {
  private orders = new Map<string, Order>();
  /** Last maker heartbeat per order id. Deliberately not persisted. */
  private seenAt = new Map<string, number>();
  private listeners: Array<() => void> = [];
  private readonly presenceTtlS: number;

  constructor(
    private readonly dataFile: string,
    opts: { presenceTtlS?: number } = {},
  ) {
    this.presenceTtlS = opts.presenceTtlS ?? DEFAULT_PRESENCE_TTL_S;
    this.load();
  }

  /** Fires after every observable change (mutation persisted, or a maker
   *  coming back online). The server uses it to push the book to
   *  streaming clients. */
  subscribe(fn: () => void): void {
    this.listeners.push(fn);
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }

  private load(): void {
    try {
      const raw = readFileSync(this.dataFile, "utf8");
      // Rows persisted before the stablecoin rollout predate the asset
      // field; absent means ETH (the wire-level default), so hydrate it
      // here and every order in memory carries a concrete asset. A
      // present-but-unknown symbol means a newer or corrupted writer;
      // relabeling it would misprice the order, so drop the row instead
      // (funds, if any, are governed on-chain, and the coordination
      // record alone is not worth crash-looping the whole book over).
      type PersistedOrder = Omit<Order, "asset"> & { asset?: string };
      const parsed = JSON.parse(raw) as PersistedOrder[];
      const now = nowS();
      for (const row of parsed) {
        const asset: string = row.asset ?? "ETH";
        if (!isKnownAsset(asset)) {
          console.warn(
            `[orderbook] dropping persisted order ${row.id}: unknown asset ${JSON.stringify(row.asset)}`,
          );
          continue;
        }
        const order: Order = { ...row, asset };
        this.orders.set(order.id, order);
        // Presence does not survive restarts; grant loaded listings one
        // TTL window so a deploy does not flap the whole book offline.
        if (order.status === "open") this.seenAt.set(order.id, now);
      }
    } catch {
      // first boot or unreadable file; start empty
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.dataFile), { recursive: true });
    const tmp = join(dirname(this.dataFile), `.orders.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify([...this.orders.values()]), "utf8");
    renameSync(tmp, this.dataFile);
    this.notify();
  }

  private isSeen(order: Order, now: number): boolean {
    return (this.seenAt.get(order.id) ?? 0) + this.presenceTtlS > now;
  }

  private pub(order: Order): PublicOrder {
    const {
      makerTokenHash: _omit,
      takerTokenHash: _omit2,
      acceptorIpHash: _omit3,
      acceptedAt: _omit4,
      releasedAt,
      ...rest
    } = order;
    return {
      ...rest,
      released: releasedAt !== undefined,
      makerSeen: this.isSeen(order, nowS()),
    };
  }

  /** Expire stale records. Chain state is the source of truth for funds;
   *  this only keeps the book readable. */
  private sweep(): void {
    const now = nowS();
    let dirty = false;
    for (const order of this.orders.values()) {
      const age = now - order.updatedAt;
      if (
        (order.status === "open" && age > OPEN_TTL_S) ||
        (order.status === "accepted" && age > ACCEPTED_TTL_S)
      ) {
        order.status = "cancelled";
        order.updatedAt = now;
        dirty = true;
      } else if (
        (order.status === "cancelled" && age > CANCELLED_TTL_S) ||
        (order.status === "locking" &&
          order.initiatorTimeout !== null &&
          now > order.initiatorTimeout + LOCKING_LINGER_S)
      ) {
        this.orders.delete(order.id);
        this.seenAt.delete(order.id);
        dirty = true;
      }
    }
    if (dirty) this.persist();
  }

  listOpen(): PublicOrder[] {
    this.sweep();
    return [...this.orders.values()]
      .filter((o) => o.status === "open")
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((o) => this.pub(o));
  }

  get(id: string): PublicOrder {
    this.sweep();
    const order = this.orders.get(id);
    if (!order) throw new ApiError(404, "order not found");
    return this.pub(order);
  }

  create(body: Record<string, unknown>): { order: PublicOrder; makerToken: string } {
    this.sweep();
    const openCount = [...this.orders.values()].filter((o) => o.status === "open").length;
    if (openCount >= MAX_OPEN_ORDERS) throw new ApiError(503, "order book is full");

    const direction = requireDirection(body["direction"]);
    // Asset first: the direction decides which side of the order is
    // denominated in the asset's base units and which is QRL wei, and
    // the amount bounds follow from that.
    const asset = requireAsset(body["asset"]);
    const [fromBounds, toBounds]: [AmountBounds, AmountBounds] =
      direction === "eth->qrl" ? [asset, QRL_BOUNDS] : [QRL_BOUNDS, asset];
    const now = nowS();
    const makerToken = randomBytes(32).toString("hex");
    const order: Order = {
      id: randomBytes(8).toString("hex"),
      direction,
      asset: asset.symbol,
      fromAmount: requireAmount(body["fromAmount"], "fromAmount", fromBounds),
      toAmount: requireAmount(body["toAmount"], "toAmount", toBounds),
      makerEthAccount: requireAddress(body["makerEthAccount"], "makerEthAccount", ETH_ADDR_RE),
      makerQrlAccount: requireAddress(body["makerQrlAccount"], "makerQrlAccount", QRL_ADDR_RE),
      status: "open",
      takerEthAccount: null,
      takerQrlAccount: null,
      hashlock: null,
      initiatorTimeout: null,
      responderTimeout: null,
      createdAt: now,
      updatedAt: now,
      makerTokenHash: sha256Hex(makerToken),
    };
    this.orders.set(order.id, order);
    this.seenAt.set(order.id, now); // creating it proves the maker is here
    this.persist();
    return { order: this.pub(order), makerToken };
  }

  /** Per-IP caps, taker validation and the open->accepted transition,
   *  shared by take-by-id and take-by-terms. The caller has already
   *  picked an `open` order. */
  private commitTake(
    order: Order,
    body: Record<string, unknown>,
    takerIp: string,
  ): { order: PublicOrder; takerToken: string } {
    const now = nowS();
    const ipHash = sha256Hex(takerIp);
    const mine = [...this.orders.values()].filter((o) => o.acceptorIpHash === ipHash);
    // A take counts as "in progress" while the taker can still act: the whole
    // accepted phase, and the locking phase only until the initiator timeout.
    // Past T1 every claim window has closed and the swap is decided on-chain
    // (refund-only), but the coordination-only book never learns the outcome,
    // so counting those (they linger ~24h for audit) would eat a concurrency
    // slot for a day even after a SUCCESSFUL swap. Released takes (the taker
    // walked away and said so) never count.
    const concurrent = mine.filter(
      (o) =>
        o.releasedAt === undefined &&
        (o.status === "accepted" ||
          (o.status === "locking" &&
            (o.initiatorTimeout === null || now <= o.initiatorTimeout))),
    ).length;
    if (concurrent >= MAX_CONCURRENT_TAKES_PER_IP) {
      throw new ApiError(429, "you already have swaps in progress; finish or let them expire");
    }
    const recent = mine.filter((o) => (o.acceptedAt ?? 0) > now - TAKE_WINDOW_S).length;
    if (recent >= MAX_TAKES_PER_IP_PER_DAY) {
      throw new ApiError(429, "daily take limit reached; leave some liquidity for others");
    }

    const takerToken = randomBytes(32).toString("hex");
    order.takerEthAccount = requireAddress(body["takerEthAccount"], "takerEthAccount", ETH_ADDR_RE);
    order.takerQrlAccount = requireAddress(body["takerQrlAccount"], "takerQrlAccount", QRL_ADDR_RE);
    order.status = "accepted";
    order.takerTokenHash = sha256Hex(takerToken);
    order.acceptorIpHash = ipHash;
    order.acceptedAt = now;
    order.updatedAt = now;
    delete order.releasedAt;
    this.persist();
    return { order: this.pub(order), takerToken };
  }

  accept(
    id: string,
    body: Record<string, unknown>,
    takerIp: string,
  ): { order: PublicOrder; takerToken: string } {
    this.sweep();
    const order = this.orders.get(id);
    if (!order) throw new ApiError(404, "order not found");
    if (order.status !== "open") throw new ApiError(409, "order is no longer open");
    return this.commitTake(order, body, takerIp);
  }

  /** Take by terms instead of by id: "I pay at most `maxPay` (the order's
   *  toAmount) to receive at least `minReceive` (the order's fromAmount)".
   *  Atomically fills the best matching open order, so two takers racing
   *  for the same row both fill while depth exists, and a stale click can
   *  only ever fill at the terms the taker saw or better. Matching is
   *  asset-scoped: a USDC request never fills an ETH order whose raw
   *  numbers happen to overlap. Offline makers are skipped: their orders
   *  are takeable by explicit id only. */
  take(
    body: Record<string, unknown>,
    takerIp: string,
  ): { order: PublicOrder; takerToken: string } {
    this.sweep();
    const direction = requireDirection(body["direction"]);
    // The taker pays the order's toAmount side and receives its
    // fromAmount side, so the asset-vs-QRL bounds mapping is the
    // reverse of create().
    const asset = requireAsset(body["asset"]);
    const [payBounds, receiveBounds]: [AmountBounds, AmountBounds] =
      direction === "eth->qrl" ? [QRL_BOUNDS, asset] : [asset, QRL_BOUNDS];
    const maxPay = BigInt(requireAmount(body["maxPay"], "maxPay", payBounds));
    const minReceive = BigInt(requireAmount(body["minReceive"], "minReceive", receiveBounds));

    const now = nowS();
    const candidates = [...this.orders.values()].filter(
      (o) =>
        o.status === "open" &&
        o.direction === direction &&
        o.asset === asset.symbol &&
        BigInt(o.toAmount) <= maxPay &&
        BigInt(o.fromAmount) >= minReceive &&
        this.isSeen(o, now),
    );
    // Best rate for the taker first (receive/pay, exact via cross
    // multiplication; rates only compare within one pair, which the
    // asset-scoped filter above guarantees), then the larger fill, then
    // FIFO.
    candidates.sort((a, b) => {
      const cross = BigInt(a.fromAmount) * BigInt(b.toAmount) - BigInt(b.fromAmount) * BigInt(a.toAmount);
      if (cross !== 0n) return cross > 0n ? -1 : 1;
      const size = BigInt(a.fromAmount) - BigInt(b.fromAmount);
      if (size !== 0n) return size > 0n ? -1 : 1;
      return a.createdAt - b.createdAt;
    });
    const best = candidates[0];
    if (!best) {
      throw new ApiError(409, "no open order matches those terms; the book may have moved");
    }
    return this.commitTake(best, body, takerIp);
  }

  private authorized(order: Order, body: Record<string, unknown>): void {
    const token = body["token"];
    if (typeof token !== "string" || sha256Hex(token) !== order.makerTokenHash) {
      throw new ApiError(403, "invalid maker token");
    }
  }

  /** Maker liveness ping (maker-token authed). In-memory only: no disk
   *  write, so it is deliberately cheap to call every few seconds. */
  heartbeat(id: string, body: Record<string, unknown>): PublicOrder {
    const order = this.orders.get(id);
    if (!order) throw new ApiError(404, "order not found");
    this.authorized(order, body);
    const now = nowS();
    const wasSeen = this.isSeen(order, now);
    this.seenAt.set(order.id, now);
    if (!wasSeen) this.notify(); // maker came back online: push the book
    return this.pub(order);
  }

  announceHashlock(id: string, body: Record<string, unknown>): PublicOrder {
    this.sweep();
    const order = this.orders.get(id);
    if (!order) throw new ApiError(404, "order not found");
    this.authorized(order, body);
    if (order.status !== "accepted") throw new ApiError(409, "order is not awaiting a hashlock");

    const hashlock = body["hashlock"];
    if (typeof hashlock !== "string" || !HASHLOCK_RE.test(hashlock)) {
      throw new ApiError(400, "hashlock must be 32 bytes of lowercase hex");
    }
    const initiatorTimeout = body["initiatorTimeout"];
    const responderTimeout = body["responderTimeout"];
    if (
      typeof initiatorTimeout !== "number" ||
      typeof responderTimeout !== "number" ||
      !Number.isInteger(initiatorTimeout) ||
      !Number.isInteger(responderTimeout)
    ) {
      throw new ApiError(400, "timeouts must be unix-second integers");
    }
    const now = nowS();
    // Invariant from the architecture spec: the initiator's window must
    // cover the responder's window twice over. Clients re-verify on-chain.
    if (responderTimeout <= now + 600) throw new ApiError(400, "responder timeout is too soon");
    if (initiatorTimeout - now < 2 * (responderTimeout - now)) {
      throw new ApiError(400, "initiator timeout must be at least 2x the responder timeout");
    }
    order.hashlock = hashlock.toLowerCase();
    order.initiatorTimeout = initiatorTimeout;
    order.responderTimeout = responderTimeout;
    order.status = "locking";
    order.updatedAt = now;
    this.persist();
    return this.pub(order);
  }

  /** Taker-authorized walk-away, the counterpart of the maker's cancel.
   *  Before the maker locks (status `accepted`) the order returns to the
   *  book untouched; after (status `locking`) the listing stays as-is,
   *  funds are governed on-chain, but the take stops occupying one of the
   *  taker's per-IP concurrency slots. The daily take count still stands:
   *  a locking-phase release already cost the maker gas and a lockup. */
  release(id: string, body: Record<string, unknown>): PublicOrder {
    this.sweep();
    const order = this.orders.get(id);
    if (!order) throw new ApiError(404, "order not found");
    const token = body["token"];
    if (
      order.takerTokenHash === undefined ||
      typeof token !== "string" ||
      sha256Hex(token) !== order.takerTokenHash
    ) {
      throw new ApiError(403, "invalid taker token");
    }
    const now = nowS();
    if (order.status === "accepted") {
      // Nothing announced, nothing locked: relist for the next taker.
      order.status = "open";
      order.takerEthAccount = null;
      order.takerQrlAccount = null;
      delete order.takerTokenHash;
      delete order.acceptorIpHash;
      delete order.acceptedAt;
      delete order.releasedAt;
      order.updatedAt = now;
      this.persist();
    } else if (order.status === "locking" && order.releasedAt === undefined) {
      order.releasedAt = now;
      order.updatedAt = now;
      this.persist();
    }
    // cancelled (or already released): idempotent success.
    return this.pub(order);
  }

  cancel(id: string, body: Record<string, unknown>): PublicOrder {
    this.sweep();
    const order = this.orders.get(id);
    if (!order) throw new ApiError(404, "order not found");
    this.authorized(order, body);
    if (order.status === "cancelled") return this.pub(order);
    // Cancelling only removes the listing. If funds were already locked
    // on-chain, the HTLC claim/refund paths still govern them.
    order.status = "cancelled";
    order.updatedAt = nowS();
    this.persist();
    return this.pub(order);
  }
}
