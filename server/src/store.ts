// Order store for protocol-mode swaps. Coordination only, never custody:
// the service carries order parameters, the taker's addresses and the
// maker's hashlock announcement. Every fact that moves funds is verified
// on-chain by both clients before they act, so a malicious or corrupted
// order book can waste time but cannot redirect a swap.

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type Direction = "eth->qrl" | "qrl->eth";
export type OrderStatus = "open" | "accepted" | "locking" | "cancelled";

export interface Order {
  id: string;
  direction: Direction;
  /** Wei the maker escrows on their from-chain, decimal string. */
  fromAmount: string;
  /** Wei the maker expects on the other chain, decimal string. */
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
}

export type PublicOrder = Omit<Order, "makerTokenHash">;

// Mirrored client-side; keep in sync with frontend/src/config.ts.
const MIN_AMOUNT_WEI = 10n ** 15n; // 0.001, dust/spam guard
const MAX_AMOUNT_WEI = 10n ** 24n;
const MAX_OPEN_ORDERS = 200;
const OPEN_TTL_S = 48 * 3600;
const ACCEPTED_TTL_S = 3600; // accepted but never locked: cancel
const CANCELLED_TTL_S = 3600;
const LOCKING_LINGER_S = 24 * 3600; // past initiator timeout

const ETH_ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const QRL_ADDR_RE = /^Q[0-9a-fA-F]{40}$/;
const HASHLOCK_RE = /^0x[0-9a-f]{64}$/;
const AMOUNT_RE = /^[0-9]{1,30}$/;

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const nowS = (): number => Math.floor(Date.now() / 1000);

const sha256Hex = (s: string): string => createHash("sha256").update(s).digest("hex");

function requireAmount(raw: unknown, field: string): string {
  if (typeof raw !== "string" || !AMOUNT_RE.test(raw)) {
    throw new ApiError(400, `${field} must be a decimal wei string`);
  }
  const wei = BigInt(raw);
  if (wei < MIN_AMOUNT_WEI) throw new ApiError(400, `${field} is below the 0.001 minimum`);
  if (wei > MAX_AMOUNT_WEI) throw new ApiError(400, `${field} exceeds the maximum`);
  return wei.toString();
}

function requireAddress(raw: unknown, field: string, re: RegExp): string {
  if (typeof raw !== "string" || !re.test(raw)) {
    throw new ApiError(400, `${field} is not a valid address`);
  }
  return raw;
}

export function toPublic(order: Order): PublicOrder {
  const { makerTokenHash: _omit, ...rest } = order;
  return rest;
}

export class OrderStore {
  private orders = new Map<string, Order>();

  constructor(private readonly dataFile: string) {
    this.load();
  }

  private load(): void {
    try {
      const raw = readFileSync(this.dataFile, "utf8");
      const parsed = JSON.parse(raw) as Order[];
      for (const order of parsed) this.orders.set(order.id, order);
    } catch {
      // first boot or unreadable file; start empty
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.dataFile), { recursive: true });
    const tmp = join(dirname(this.dataFile), `.orders.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify([...this.orders.values()]), "utf8");
    renameSync(tmp, this.dataFile);
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
      .map(toPublic);
  }

  get(id: string): PublicOrder {
    this.sweep();
    const order = this.orders.get(id);
    if (!order) throw new ApiError(404, "order not found");
    return toPublic(order);
  }

  create(body: Record<string, unknown>): { order: PublicOrder; makerToken: string } {
    this.sweep();
    const openCount = [...this.orders.values()].filter((o) => o.status === "open").length;
    if (openCount >= MAX_OPEN_ORDERS) throw new ApiError(503, "order book is full");

    const direction = body["direction"];
    if (direction !== "eth->qrl" && direction !== "qrl->eth") {
      throw new ApiError(400, "direction must be eth->qrl or qrl->eth");
    }
    const now = nowS();
    const makerToken = randomBytes(32).toString("hex");
    const order: Order = {
      id: randomBytes(8).toString("hex"),
      direction,
      fromAmount: requireAmount(body["fromAmount"], "fromAmount"),
      toAmount: requireAmount(body["toAmount"], "toAmount"),
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
    this.persist();
    return { order: toPublic(order), makerToken };
  }

  accept(id: string, body: Record<string, unknown>): PublicOrder {
    this.sweep();
    const order = this.orders.get(id);
    if (!order) throw new ApiError(404, "order not found");
    if (order.status !== "open") throw new ApiError(409, "order is no longer open");
    order.takerEthAccount = requireAddress(body["takerEthAccount"], "takerEthAccount", ETH_ADDR_RE);
    order.takerQrlAccount = requireAddress(body["takerQrlAccount"], "takerQrlAccount", QRL_ADDR_RE);
    order.status = "accepted";
    order.updatedAt = nowS();
    this.persist();
    return toPublic(order);
  }

  private authorized(order: Order, body: Record<string, unknown>): void {
    const token = body["token"];
    if (typeof token !== "string" || sha256Hex(token) !== order.makerTokenHash) {
      throw new ApiError(403, "invalid maker token");
    }
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
    return toPublic(order);
  }

  cancel(id: string, body: Record<string, unknown>): PublicOrder {
    this.sweep();
    const order = this.orders.get(id);
    if (!order) throw new ApiError(404, "order not found");
    this.authorized(order, body);
    if (order.status === "cancelled") return toPublic(order);
    // Cancelling only removes the listing. If funds were already locked
    // on-chain, the HTLC claim/refund paths still govern them.
    order.status = "cancelled";
    order.updatedAt = nowS();
    this.persist();
    return toPublic(order);
  }
}
