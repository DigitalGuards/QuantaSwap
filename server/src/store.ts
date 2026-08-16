// Order store for protocol-mode swaps. Coordination only, never custody:
// the service carries order parameters, the taker's addresses and the
// maker's hashlock announcement. Every fact that moves funds is verified
// on-chain by both clients before they act, so a malicious or corrupted
// order book can waste time but cannot redirect a swap.

import { createHash, randomBytes } from "node:crypto";
import {
  accessSync,
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { QRL_BOUNDS, isKnownAsset, requireAsset, type AmountBounds, type AssetSymbol } from "./assets.js";
import { ApiError } from "./errors.js";

export { ApiError } from "./errors.js";

export type Direction = "eth->qrl" | "qrl->eth";
export type OrderStatus = "open" | "accepted" | "locking" | "cancelled";
export type Visibility = "public" | "private";

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
  /** Pre-funded listing: the maker escrowed on-chain at post time, so
   *  `hashlock` and `initiatorTimeout` are already set while the order is
   *  still open (for every other row, non-null hashlock implies status
   *  `locking`). Announce must echo both verbatim. Absent means classic.
   *  The book cannot verify the escrow; clients check it on-chain. */
  prelocked?: boolean;
  createdAt: number;
  updatedAt: number;
  /** Private orders are excluded from the public list, the SSE stream
   *  and take-by-terms; they are reachable only by id, gated on the
   *  share token. Rows persisted before the feature mean public. */
  visibility: Visibility;
  /** sha256 of a private order's share token (the capability-URL
   *  secret); never serialized to clients. Present iff private. */
  shareTokenHash?: string;
  /** Optional taker restriction on private orders: accept rejects any
   *  other taker address. A convenience filter only; the maker's client
   *  re-verifies the taker independently before locking, and the HTLC
   *  fixes the recipient at lock time. */
  allowedTakerEth?: string;
  allowedTakerQrl?: string;
  /** sha256 of the maker's bearer token; never serialized to clients. */
  makerTokenHash: string;
  /** sha256 of the taker's bearer token (minted on accept, authorizes
   *  release); never serialized to clients. */
  takerTokenHash?: string;
  /** sha256 of the taker's IP, for per-IP take caps; never serialized. */
  acceptorIpHash?: string;
  /** sha256 of the creator's IP, for open-listing caps; never serialized. */
  creatorIpHash?: string;
  acceptedAt?: number;
  /** Taker walked away after the maker locked. The order stays `locking`
   *  (chain state governs the funds) but stops counting as an in-progress
   *  take for the taker's IP. */
  releasedAt?: number;
}

export type PublicOrder = Omit<
  Order,
  | "makerTokenHash"
  | "takerTokenHash"
  | "acceptorIpHash"
  | "creatorIpHash"
  | "acceptedAt"
  | "releasedAt"
  | "shareTokenHash"
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
const MAX_OPEN_ORDERS_PER_MAKER = 40;
const MAX_OPEN_ORDERS_PER_IP = 50;
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
// How long a locking-phase take holds a concurrency slot, measured from
// accept. A swap can only be in flight for the responder window (1h) plus
// claim margins; 2h matches the classic T1 (announce + 2h) so classic
// behavior is unchanged, while a prelocked order's fixed multi-day T1 no
// longer pins the slot long after the swap settled.
const LOCKING_SLOT_HORIZON_S = 2 * 3600;

// Pre-funded (prelocked) listings: the T1 window accepted at create, and
// the remaining-runway floor under which they stop being takeable. The
// floor is the announce-time 2x invariant for a fresh 1h responder window
// (7200s) plus the clients' 30min claim margin, so an order taken at the
// edge still clears both the announce check below and the taker's
// on-chain timeout verification after accept->announce->assign latency.
const PRELOCK_MIN_T1_S = 3 * 3600;
const PRELOCK_MAX_T1_S = 72 * 3600;
const MIN_TAKEABLE_RUNWAY_S = 2 * 3600 + 1800;

const ETH_ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const QRL_ADDR_RE = /^Q[0-9a-fA-F]{40}$/;
const HASHLOCK_RE = /^0x[0-9a-f]{64}$/;
const TOKEN_HASH_RE = /^[0-9a-f]{64}$/;
const ORDER_ID_RE = /^[0-9a-f]{16}$/;
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

export class OrderStorePersistenceError extends Error {
  override name = "OrderStorePersistenceError";
}

function invalidPersisted(index: number, field: string): never {
  throw new Error(`persisted order ${index} has an invalid ${field}`);
}

function matchingString(
  row: Record<string, unknown>,
  index: number,
  field: string,
  pattern: RegExp,
): string {
  const value = row[field];
  if (typeof value !== "string" || !pattern.test(value)) invalidPersisted(index, field);
  return value;
}

function optionalMatchingString(
  row: Record<string, unknown>,
  index: number,
  field: string,
  pattern: RegExp,
): string | undefined {
  const value = row[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !pattern.test(value)) invalidPersisted(index, field);
  return value;
}

function nullableMatchingString(
  row: Record<string, unknown>,
  index: number,
  field: string,
  pattern: RegExp,
): string | null {
  const value = row[field];
  if (value === null) return null;
  if (typeof value !== "string" || !pattern.test(value)) invalidPersisted(index, field);
  return value;
}

function safeInteger(row: Record<string, unknown>, index: number, field: string): number {
  const value = row[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    invalidPersisted(index, field);
  }
  return value;
}

function optionalSafeInteger(
  row: Record<string, unknown>,
  index: number,
  field: string,
): number | undefined {
  if (row[field] === undefined) return undefined;
  return safeInteger(row, index, field);
}

function nullableSafeInteger(
  row: Record<string, unknown>,
  index: number,
  field: string,
): number | null {
  if (row[field] === null) return null;
  return safeInteger(row, index, field);
}

function hydratePersistedOrder(raw: unknown, index: number): Order {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    invalidPersisted(index, "record");
  }
  const row = raw as Record<string, unknown>;
  const direction = row["direction"];
  if (direction !== "eth->qrl" && direction !== "qrl->eth") {
    invalidPersisted(index, "direction");
  }
  const status = row["status"];
  if (status !== "open" && status !== "accepted" && status !== "locking" && status !== "cancelled") {
    invalidPersisted(index, "status");
  }

  const rawAsset = row["asset"] ?? "ETH";
  if (typeof rawAsset !== "string" || !isKnownAsset(rawAsset)) {
    invalidPersisted(index, "asset");
  }
  const shareTokenHash = optionalMatchingString(row, index, "shareTokenHash", TOKEN_HASH_RE);
  const rawVisibility = row["visibility"];
  if (rawVisibility !== undefined && rawVisibility !== "public" && rawVisibility !== "private") {
    invalidPersisted(index, "visibility");
  }
  const visibility: Visibility =
    rawVisibility === "private" || shareTokenHash !== undefined ? "private" : "public";

  const hashlock = nullableMatchingString(row, index, "hashlock", HASHLOCK_RE);
  const initiatorTimeout = nullableSafeInteger(row, index, "initiatorTimeout");
  const responderTimeout = nullableSafeInteger(row, index, "responderTimeout");
  const prelocked = row["prelocked"] === true && hashlock !== null && initiatorTimeout !== null;
  const allowedTakerEth = optionalMatchingString(row, index, "allowedTakerEth", ETH_ADDR_RE);
  const allowedTakerQrl = optionalMatchingString(row, index, "allowedTakerQrl", QRL_ADDR_RE);
  const takerTokenHash = optionalMatchingString(row, index, "takerTokenHash", TOKEN_HASH_RE);
  const acceptorIpHash = optionalMatchingString(row, index, "acceptorIpHash", TOKEN_HASH_RE);
  const creatorIpHash = optionalMatchingString(row, index, "creatorIpHash", TOKEN_HASH_RE);
  const acceptedAt = optionalSafeInteger(row, index, "acceptedAt");
  const releasedAt = optionalSafeInteger(row, index, "releasedAt");

  return {
    id: matchingString(row, index, "id", ORDER_ID_RE),
    direction,
    asset: rawAsset,
    fromAmount: matchingString(row, index, "fromAmount", AMOUNT_RE),
    toAmount: matchingString(row, index, "toAmount", AMOUNT_RE),
    makerEthAccount: matchingString(row, index, "makerEthAccount", ETH_ADDR_RE),
    makerQrlAccount: matchingString(row, index, "makerQrlAccount", QRL_ADDR_RE),
    status,
    takerEthAccount: nullableMatchingString(row, index, "takerEthAccount", ETH_ADDR_RE),
    takerQrlAccount: nullableMatchingString(row, index, "takerQrlAccount", QRL_ADDR_RE),
    hashlock,
    initiatorTimeout,
    responderTimeout,
    ...(prelocked ? { prelocked: true } : {}),
    createdAt: safeInteger(row, index, "createdAt"),
    updatedAt: safeInteger(row, index, "updatedAt"),
    visibility,
    ...(shareTokenHash !== undefined ? { shareTokenHash } : {}),
    ...(allowedTakerEth !== undefined ? { allowedTakerEth } : {}),
    ...(allowedTakerQrl !== undefined ? { allowedTakerQrl } : {}),
    makerTokenHash: matchingString(row, index, "makerTokenHash", TOKEN_HASH_RE),
    ...(takerTokenHash !== undefined ? { takerTokenHash } : {}),
    ...(acceptorIpHash !== undefined ? { acceptorIpHash } : {}),
    ...(creatorIpHash !== undefined ? { creatorIpHash } : {}),
    ...(acceptedAt !== undefined ? { acceptedAt } : {}),
    ...(releasedAt !== undefined ? { releasedAt } : {}),
  };
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
    this.prepareStorage();
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

  private prepareStorage(): void {
    const directory = dirname(this.dataFile);
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      accessSync(directory, fsConstants.R_OK | fsConstants.W_OK);
      if (existsSync(this.dataFile)) {
        accessSync(this.dataFile, fsConstants.R_OK | fsConstants.W_OK);
        chmodSync(this.dataFile, 0o600);
      }
    } catch {
      throw new Error(`order data path is not readable and writable: ${this.dataFile}`);
    }
  }

  storageReady(): boolean {
    try {
      accessSync(dirname(this.dataFile), fsConstants.R_OK | fsConstants.W_OK);
      if (existsSync(this.dataFile)) {
        accessSync(this.dataFile, fsConstants.R_OK | fsConstants.W_OK);
      }
      return true;
    } catch {
      return false;
    }
  }

  private load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.dataFile, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new Error(`order data file could not be read: ${this.dataFile}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`order data file is not valid JSON: ${this.dataFile}`);
    }
    if (!Array.isArray(parsed)) {
      throw new Error(`order data file must contain an array: ${this.dataFile}`);
    }

    const now = nowS();
    for (const [index, row] of parsed.entries()) {
      const order = hydratePersistedOrder(row, index);
      if (this.orders.has(order.id)) {
        throw new Error(`order data file contains duplicate id ${order.id}`);
      }
      if (
        order.hashlock !== null &&
        order.status !== "cancelled" &&
        [...this.orders.values()].some(
          (existing) => existing.status !== "cancelled" && existing.hashlock === order.hashlock,
        )
      ) {
        throw new Error(`order data file contains duplicate live hashlock ${order.hashlock}`);
      }
      this.orders.set(order.id, order);
      // Presence does not survive restarts; grant loaded listings one
      // TTL window so a deploy does not flap the whole book offline.
      if (order.status === "open") this.seenAt.set(order.id, now);
    }
  }

  private persist(): void {
    const directory = dirname(this.dataFile);
    const suffix = randomBytes(8).toString("hex");
    const tmp = join(directory, `.orders.${process.pid}.${suffix}.tmp`);
    let fileDescriptor: number | undefined;
    try {
      fileDescriptor = openSync(tmp, "wx", 0o600);
      fchmodSync(fileDescriptor, 0o600);
      writeFileSync(fileDescriptor, JSON.stringify([...this.orders.values()]), "utf8");
      fsyncSync(fileDescriptor);
      closeSync(fileDescriptor);
      fileDescriptor = undefined;
      renameSync(tmp, this.dataFile);

      const directoryDescriptor = openSync(directory, "r");
      try {
        fsyncSync(directoryDescriptor);
      } finally {
        closeSync(directoryDescriptor);
      }
    } catch {
      if (fileDescriptor !== undefined) {
        try {
          closeSync(fileDescriptor);
        } catch {
          // Preserve the original persistence failure.
        }
      }
      try {
        unlinkSync(tmp);
      } catch {
        // The rename may already have consumed the temporary file.
      }
      throw new OrderStorePersistenceError("order data could not be persisted safely");
    }
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
      creatorIpHash: _omit4,
      acceptedAt: _omit5,
      shareTokenHash: _omit6,
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

  /** A prelocked listing is takeable only while enough of its fixed T1
   *  remains for a full swap (see MIN_TAKEABLE_RUNWAY_S); past the floor
   *  it stops being offered and waits for the maker to release + relist.
   *  Classic orders have no T1 until announce and always pass. */
  private hasRunway(order: Order, now: number): boolean {
    return (
      order.prelocked !== true ||
      order.initiatorTimeout === null ||
      order.initiatorTimeout - now >= MIN_TAKEABLE_RUNWAY_S
    );
  }

  listOpen(): PublicOrder[] {
    this.sweep();
    const now = nowS();
    return [...this.orders.values()]
      .filter((o) => o.status === "open" && o.visibility === "public" && this.hasRunway(o, now))
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((o) => this.pub(o));
  }

  /** Private orders demand the share token and 404 without it: an id
   *  alone (which transits URLs and access logs) must not confirm a
   *  private listing exists, let alone reveal its terms. */
  get(id: string, shareToken?: string): PublicOrder {
    this.sweep();
    const order = this.orders.get(id);
    if (!order) throw new ApiError(404, "order not found");
    if (order.visibility === "private" && !this.shareAuthorized(order, shareToken)) {
      throw new ApiError(404, "order not found");
    }
    return this.pub(order);
  }

  private shareAuthorized(order: Order, shareToken: unknown): boolean {
    return (
      typeof shareToken === "string" &&
      order.shareTokenHash !== undefined &&
      sha256Hex(shareToken) === order.shareTokenHash
    );
  }

  create(body: Record<string, unknown>, makerIp = "unknown"): {
    order: PublicOrder;
    makerToken: string;
    shareToken?: string;
  } {
    this.sweep();
    const openOrders = [...this.orders.values()].filter((o) => o.status === "open");
    if (openOrders.length >= MAX_OPEN_ORDERS) throw new ApiError(503, "order book is full");

    const direction = requireDirection(body["direction"]);
    // Asset first: the direction decides which side of the order is
    // denominated in the asset's base units and which is QRL wei, and
    // the amount bounds follow from that.
    const asset = requireAsset(body["asset"]);
    const [fromBounds, toBounds]: [AmountBounds, AmountBounds] =
      direction === "eth->qrl" ? [asset, QRL_BOUNDS] : [QRL_BOUNDS, asset];
    const fromAmount = requireAmount(body["fromAmount"], "fromAmount", fromBounds);
    const toAmount = requireAmount(body["toAmount"], "toAmount", toBounds);
    const makerEthAccount = requireAddress(
      body["makerEthAccount"],
      "makerEthAccount",
      ETH_ADDR_RE,
    );
    const makerQrlAccount = requireAddress(
      body["makerQrlAccount"],
      "makerQrlAccount",
      QRL_ADDR_RE,
    );

    const makerOpenCount = openOrders.filter(
      (order) =>
        order.makerEthAccount.toLowerCase() === makerEthAccount.toLowerCase() &&
        order.makerQrlAccount.toLowerCase() === makerQrlAccount.toLowerCase(),
    ).length;
    if (makerOpenCount >= MAX_OPEN_ORDERS_PER_MAKER) {
      throw new ApiError(429, "maker already has too many open orders");
    }
    const creatorIpHash = sha256Hex(makerIp);
    const sourceOpenCount = openOrders.filter(
      (order) => order.creatorIpHash === creatorIpHash,
    ).length;
    if (sourceOpenCount >= MAX_OPEN_ORDERS_PER_IP) {
      throw new ApiError(429, "source already has too many open orders");
    }

    const rawVisibility = body["visibility"];
    if (rawVisibility !== undefined && rawVisibility !== "public" && rawVisibility !== "private") {
      throw new ApiError(400, "visibility must be public or private");
    }
    const visibility: Visibility = rawVisibility === "private" ? "private" : "public";
    // The share token is the capability that finds and takes the order
    // (shared out of band by the maker); the optional taker restriction
    // pins the counterparty even if the link leaks. Neither makes sense
    // on a publicly listed order.
    let shareToken: string | undefined;
    let allowedTakerEth: string | undefined;
    let allowedTakerQrl: string | undefined;
    if (visibility === "private") {
      shareToken = randomBytes(32).toString("hex");
      if (body["allowedTakerEth"] !== undefined) {
        allowedTakerEth = requireAddress(body["allowedTakerEth"], "allowedTakerEth", ETH_ADDR_RE);
      }
      if (body["allowedTakerQrl"] !== undefined) {
        allowedTakerQrl = requireAddress(body["allowedTakerQrl"], "allowedTakerQrl", QRL_ADDR_RE);
      }
    } else if (body["allowedTakerEth"] !== undefined || body["allowedTakerQrl"] !== undefined) {
      throw new ApiError(400, "taker restrictions require a private order");
    }

    const now = nowS();
    // Pre-funded listings: the maker already escrowed on-chain under this
    // hashlock with a long fixed T1; announce later reuses both verbatim.
    // Shape and window checks only; the escrow itself is verified on-chain
    // by clients (the book has no RPC and never trusts itself anyway).
    let prelock: { hashlock: string; initiatorTimeout: number } | undefined;
    const rawPrelock = body["prelock"];
    if (rawPrelock !== undefined) {
      if (typeof rawPrelock !== "object" || rawPrelock === null) {
        throw new ApiError(400, "prelock must be an object");
      }
      const p = rawPrelock as Record<string, unknown>;
      const hashlock = p["hashlock"];
      if (typeof hashlock !== "string" || !HASHLOCK_RE.test(hashlock)) {
        throw new ApiError(400, "prelock.hashlock must be 32 bytes of lowercase hex");
      }
      const initiatorTimeout = p["initiatorTimeout"];
      if (typeof initiatorTimeout !== "number" || !Number.isInteger(initiatorTimeout)) {
        throw new ApiError(400, "prelock.initiatorTimeout must be a unix-second integer");
      }
      if (initiatorTimeout < now + PRELOCK_MIN_T1_S) {
        throw new ApiError(400, "prelock.initiatorTimeout is too soon for a takeable listing");
      }
      if (initiatorTimeout > now + PRELOCK_MAX_T1_S) {
        throw new ApiError(400, "prelock.initiatorTimeout is too far out");
      }
      const normalized = hashlock.toLowerCase();
      // One live book row per hashlock: the contract enforces single-use
      // on-chain, and two listings sharing one escrow could each pass the
      // announce echo check while only one swap can ever settle.
      for (const other of this.orders.values()) {
        if (other.hashlock === normalized && other.status !== "cancelled") {
          throw new ApiError(409, "an order with this hashlock already exists");
        }
      }
      prelock = { hashlock: normalized, initiatorTimeout };
    }

    const makerToken = randomBytes(32).toString("hex");
    const order: Order = {
      id: randomBytes(8).toString("hex"),
      direction,
      asset: asset.symbol,
      visibility,
      ...(shareToken !== undefined ? { shareTokenHash: sha256Hex(shareToken) } : {}),
      ...(allowedTakerEth !== undefined ? { allowedTakerEth } : {}),
      ...(allowedTakerQrl !== undefined ? { allowedTakerQrl } : {}),
      fromAmount,
      toAmount,
      makerEthAccount,
      makerQrlAccount,
      status: "open",
      takerEthAccount: null,
      takerQrlAccount: null,
      hashlock: prelock?.hashlock ?? null,
      initiatorTimeout: prelock?.initiatorTimeout ?? null,
      responderTimeout: null,
      ...(prelock !== undefined ? { prelocked: true } : {}),
      createdAt: now,
      updatedAt: now,
      makerTokenHash: sha256Hex(makerToken),
      creatorIpHash,
    };
    this.orders.set(order.id, order);
    this.seenAt.set(order.id, now); // creating it proves the maker is here
    this.persist();
    return {
      order: this.pub(order),
      makerToken,
      ...(shareToken !== undefined ? { shareToken } : {}),
    };
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
    // accepted phase, and the locking phase only within the swap horizon.
    // For a classic order T1 = announce + 2h already bounds that; a prelocked
    // order's T1 is fixed at post (up to 72h out), so counting until T1 would
    // pin a slot for days after a completed-but-unreleased prelocked take.
    // Cap the locking horizon at min(T1, acceptedAt + LOCKING_SLOT_HORIZON_S):
    // classic orders are unaffected (that min is essentially T1), prelocked
    // orders free the slot once the swap can no longer be in flight. Past the
    // horizon the swap is decided on-chain (refund-only) and the coordination
    // book never learns the outcome. Released takes never count.
    const lockingSlotActive = (o: Order): boolean => {
      if (o.status !== "locking") return false;
      const t1 = o.initiatorTimeout ?? Number.POSITIVE_INFINITY;
      const horizon = Math.min(t1, (o.acceptedAt ?? now) + LOCKING_SLOT_HORIZON_S);
      return now <= horizon;
    };
    const concurrent = mine.filter(
      (o) => o.releasedAt === undefined && (o.status === "accepted" || lockingSlotActive(o)),
    ).length;
    if (concurrent >= MAX_CONCURRENT_TAKES_PER_IP) {
      throw new ApiError(429, "you already have swaps in progress; finish or let them expire");
    }
    const recent = mine.filter((o) => (o.acceptedAt ?? 0) > now - TAKE_WINDOW_S).length;
    if (recent >= MAX_TAKES_PER_IP_PER_DAY) {
      throw new ApiError(429, "daily take limit reached; leave some liquidity for others");
    }

    const takerEthAccount = requireAddress(body["takerEthAccount"], "takerEthAccount", ETH_ADDR_RE);
    const takerQrlAccount = requireAddress(body["takerQrlAccount"], "takerQrlAccount", QRL_ADDR_RE);
    // Maker-declared taker restriction (private OTC orders): a courtesy
    // filter here; the maker's client re-verifies the taker before
    // locking, and the HTLC fixes the recipient at lock time.
    if (
      (order.allowedTakerEth !== undefined &&
        order.allowedTakerEth.toLowerCase() !== takerEthAccount.toLowerCase()) ||
      (order.allowedTakerQrl !== undefined &&
        order.allowedTakerQrl.toLowerCase() !== takerQrlAccount.toLowerCase())
    ) {
      throw new ApiError(403, "this order is reserved for a specific taker");
    }

    const takerToken = randomBytes(32).toString("hex");
    order.takerEthAccount = takerEthAccount;
    order.takerQrlAccount = takerQrlAccount;
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
    // Same 404 as a missing order: an id alone must not confirm a
    // private listing exists.
    if (order.visibility === "private" && !this.shareAuthorized(order, body["shareToken"])) {
      throw new ApiError(404, "order not found");
    }
    if (order.status !== "open") throw new ApiError(409, "order is no longer open");
    if (!this.hasRunway(order, nowS())) {
      throw new ApiError(409, "this pre-funded order has too little time left to swap safely");
    }
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
        o.visibility === "public" &&
        o.direction === direction &&
        o.asset === asset.symbol &&
        BigInt(o.toAmount) <= maxPay &&
        BigInt(o.fromAmount) >= minReceive &&
        this.isSeen(o, now) &&
        this.hasRunway(o, now),
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
    if (order.prelocked === true) {
      // A pre-funded order's hashlock and T1 were fixed at post time (the
      // escrow already sits on-chain under them); the maker client must
      // echo them exactly. A mismatch means a desynced maker, e.g. one
      // that lost local state and regenerated a secret: refuse before the
      // taker wastes a verification round on an escrow that cannot match.
      if (hashlock.toLowerCase() !== order.hashlock) {
        throw new ApiError(400, "hashlock does not match the pre-funded escrow");
      }
      if (initiatorTimeout !== order.initiatorTimeout) {
        throw new ApiError(400, "initiatorTimeout does not match the pre-funded escrow");
      }
    }
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
