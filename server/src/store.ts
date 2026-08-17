// Order store for protocol-mode swaps. Coordination only, never custody:
// the service carries order parameters, the taker's addresses and the
// maker's hashlock announcement. Every fact that moves funds is verified
// on-chain by both clients before they act, so a malicious or corrupted
// order book can waste time but cannot redirect a swap.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
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
import {
  computeReleaseCommitment,
  computeMakerTokenCommitment,
  computeShareTokenCommitment,
  verifyCancelV1,
  verifyFillIntentV1,
  verifyFillV1,
  verifyOrderV1,
  type CancelV1Body,
  type FillIntentV1Body,
  type FillV1Body,
  type MakerOrderAuthV1,
  type ProtocolAuthV1,
  type VerifiedFillIntentV1,
  type VerifiedOrderV1,
} from "./order-signing.js";
import type { FederationEvent } from "./federation.js";

export { ApiError } from "./errors.js";

export type Direction = "eth->qrl" | "qrl->eth";
export type OrderStatus = "open" | "accepted" | "locking" | "cancelled";
export type Visibility = "public" | "private";

export interface StoredFillIntentV1 {
  intentDigest: string;
  intent: FillIntentV1Body;
  auth: ProtocolAuthV1;
  receivedAt: number;
  acceptorIpHash: string;
  releasedAt?: number;
  releaseSecret?: string;
}

export type PublicFillIntentV1 = Omit<
  StoredFillIntentV1,
  "acceptorIpHash" | "releasedAt" | "releaseSecret"
>;

export type TerminalConflictEvidence =
  | {
      kind: "fill-v1";
      digest: string;
      body: FillV1Body;
      auth: ProtocolAuthV1;
      intent: FillIntentV1Body;
      intentAuth: ProtocolAuthV1;
    }
  | {
      kind: "cancel-v1";
      digest: string;
      body: CancelV1Body;
      auth: ProtocolAuthV1;
    };

export interface OrderConflictEvidence {
  orderDigest: string;
  order: Record<string, unknown>;
  auth: ProtocolAuthV1;
}

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
  /** Opaque hash of the directly connected federation peer that first
   *  supplied this order. Used only for per-peer retained-state quotas. */
  federationSourceHash?: string;
  /** Portable maker authorization. Absent only on legacy/local-liquidity
   *  rows created through the unsigned compatibility endpoint. */
  makerAuth?: MakerOrderAuthV1;
  /** Scheme-independent semantic digest of the canonical OrderV1. */
  orderDigest?: string;
  /** Short-lived signed taker proposals. Hidden from public order views. */
  fillIntents?: StoredFillIntentV1[];
  /** Maker-signed terminal selection and hashlock announcement. */
  fill?: FillV1Body;
  fillAuth?: ProtocolAuthV1;
  fillDigest?: string;
  /** The exact signed intent selected by FillV1, retained for verification. */
  selectedIntent?: PublicFillIntentV1;
  /** Maker-signed permanent withdrawal when no fill was selected. */
  cancelProof?: CancelV1Body;
  cancelAuth?: ProtocolAuthV1;
  cancelDigest?: string;
  /** Conflicting maker terminal proofs quarantine this order. */
  equivocated?: boolean;
  conflicts?: TerminalConflictEvidence[];
  orderConflicts?: OrderConflictEvidence[];
  acceptedAt?: number;
  /** Taker walked away after the maker locked. The order stays `locking`
   *  (chain state governs the funds) but stops counting as an in-progress
   *  take for the taker's IP. */
  releasedAt?: number;
  /** ReleaseV1 preimage retained so a mirror reset can reconstruct the
   *  release event. It is never included in ordinary order responses. */
  releaseSecret?: string;
}

export type PublicOrder = Omit<
  Order,
  | "makerTokenHash"
  | "takerTokenHash"
  | "acceptorIpHash"
  | "creatorIpHash"
  | "federationSourceHash"
  | "acceptedAt"
  | "releasedAt"
  | "releaseSecret"
  | "shareTokenHash"
  | "fillIntents"
  | "conflicts"
  | "orderConflicts"
> & {
  /** The taker released a locking-phase order: the maker should not
   *  (further) commit funds to it. Derived from `releasedAt`. */
  released: boolean;
  /** The maker's client heartbeated recently, so a take can actually
   *  proceed. Presence is in-memory only: a restart grants every loaded
   *  open order one grace window to re-heartbeat. */
  makerSeen: boolean;
  /** Digests are enough for clients to identify retained conflict evidence;
   *  complete proofs remain in durable mirror state and the event feed. */
  conflictDigests?: string[];
};

// Per-asset amount bounds live in assets.ts (mirrored client-side).
const MAX_OPEN_ORDERS = 200;
const MAX_OPEN_ORDERS_PER_MAKER = 40;
const MAX_OPEN_ORDERS_PER_IP = 50;
const MAX_RETAINED_ORDERS = 256;
const MAX_RETAINED_ORDERS_PER_MAKER = 64;
const MAX_RETAINED_ORDERS_PER_IP = 64;
const MAX_RETAINED_FEDERATED_ORDERS = 128;
export const MAX_PUBLIC_PORTABLE_ORDERS = 64;
export const MAX_FEDERATED_PUBLIC_PORTABLE_ORDERS = 48;
export const MAX_PUBLIC_PORTABLE_ORDERS_PER_FEDERATION_PEER = 16;
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
const MAX_FILL_INTENTS_PER_ORDER = 8;
const MAX_CONFLICT_PROOFS = 2;
const SIGNED_TERMINAL_GRACE_S = 5 * 60;
const MAX_FILL_RESPONSE_S = 15 * 60;
const SIGNED_INTENT_RETENTION_S = MAX_FILL_RESPONSE_S + SIGNED_TERMINAL_GRACE_S;
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
const BYTES32_RE = /^0x[0-9a-f]{64}$/;
const TOKEN_HASH_RE = /^[0-9a-f]{64}$/;
const RAW_TOKEN_RE = /^[0-9a-f]{64}$/;
const ORDER_ID_RE = /^(?:[0-9a-f]{16}|[0-9a-f]{64})$/;
const AMOUNT_RE = /^[0-9]{1,30}$/;

const nowS = (): number => Math.floor(Date.now() / 1000);

const sha256Hex = (s: string): string => createHash("sha256").update(s).digest("hex");

function exactRawToken(raw: unknown, field: string): string {
  if (typeof raw !== "string" || !RAW_TOKEN_RE.test(raw)) {
    throw new ApiError(400, `${field} must be 32 bytes of lowercase hex`);
  }
  return raw;
}

function fixedHexMatches(storedHex: string, candidateHex: string): boolean {
  const left = Buffer.from(storedHex, "hex");
  const right = Buffer.from(candidateHex, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

function capabilityMatches(
  storedHex: string,
  raw: unknown,
  compute: (token: string) => string,
): boolean {
  return (
    typeof raw === "string" &&
    RAW_TOKEN_RE.test(raw) &&
    fixedHexMatches(storedHex, compute(raw).slice(2))
  );
}

function legacyTokenMatches(storedHex: string, raw: unknown): boolean {
  return (
    typeof raw === "string" &&
    fixedHexMatches(storedHex, sha256Hex(raw))
  );
}

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

function signedOrderBody(order: Order): Record<string, unknown> {
  return {
    direction: order.direction,
    asset: order.asset,
    fromAmount: order.fromAmount,
    toAmount: order.toAmount,
    makerEthAccount: order.makerEthAccount,
    makerQrlAccount: order.makerQrlAccount,
    visibility: order.visibility,
    ...(order.allowedTakerEth !== undefined
      ? { allowedTakerEth: order.allowedTakerEth }
      : {}),
    ...(order.allowedTakerQrl !== undefined
      ? { allowedTakerQrl: order.allowedTakerQrl }
      : {}),
    ...(order.prelocked === true && order.hashlock !== null && order.initiatorTimeout !== null
      ? {
          prelock: {
            hashlock: order.hashlock,
            initiatorTimeout: order.initiatorTimeout,
          },
        }
      : {}),
  };
}

function verifiedSignedOrder(order: Order): VerifiedOrderV1 {
  if (order.makerAuth === undefined) throw new ApiError(409, "order is not portable");
  return verifyOrderV1(signedOrderBody(order), order.makerAuth, { allowExpired: true });
}

function referencedSignedOrderVariant(
  order: Order,
  rawTerminal: unknown,
): VerifiedOrderV1 {
  if (typeof rawTerminal !== "object" || rawTerminal === null || Array.isArray(rawTerminal)) {
    throw new ApiError(400, "terminal proof must be an object");
  }
  const digest = (rawTerminal as Record<string, unknown>)["orderDigest"];
  if (typeof digest !== "string" || !BYTES32_RE.test(digest)) {
    throw new ApiError(400, "terminal proof has an invalid orderDigest");
  }
  const primary = verifiedSignedOrder(order);
  if (primary.orderDigest === digest) return primary;
  for (const conflict of order.orderConflicts ?? []) {
    if (conflict.orderDigest !== digest) continue;
    const candidate = verifyOrderV1(conflict.order, conflict.auth, {
      allowExpired: true,
    });
    if (candidate.orderId !== order.id || candidate.orderDigest !== digest) break;
    return candidate;
  }
  throw new ApiError(
    409,
    "referenced signed order variant is unavailable",
    "federation_dependency",
  );
}

/** Signed rows created without the terminal protocol remain origin-local. */
function usesPortableTerminalProtocol(order: Order): boolean {
  return order.makerAuth !== undefined && order.fillIntents !== undefined;
}

function signedCreateCapabilities(
  verified: VerifiedOrderV1,
  raw: { makerToken: unknown; shareToken?: unknown },
): { makerToken: string; shareToken?: string } {
  const makerCommitment = verified.auth.makerTokenCommitment;
  const shareCommitment = verified.auth.shareTokenCommitment;
  const makerToken = exactRawToken(raw.makerToken, "makerToken");
  if (!capabilityMatches(makerCommitment.slice(2), makerToken, computeMakerTokenCommitment)) {
    throw new ApiError(401, "makerToken does not match the signed commitment");
  }
  if (verified.terms.visibility === "public") {
    if (raw.shareToken !== undefined) {
      throw new ApiError(400, "public signed orders cannot carry a shareToken");
    }
    return { makerToken };
  }
  const shareToken = exactRawToken(raw.shareToken, "shareToken");
  if (!capabilityMatches(shareCommitment.slice(2), shareToken, computeShareTokenCommitment)) {
    throw new ApiError(401, "shareToken does not match the signed commitment");
  }
  return { makerToken, shareToken };
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

function persistedObject(raw: unknown, index: number, field: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    invalidPersisted(index, field);
  }
  return raw as Record<string, unknown>;
}

function exactPayload(
  raw: Record<string, unknown>,
  fields: readonly string[],
  label: string,
): Record<string, unknown> {
  const keys = Object.keys(raw).sort();
  const expected = [...fields].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new ApiError(400, `${label} has unexpected fields`);
  }
  return raw;
}

function hydrateIntentProof(
  raw: unknown,
  index: number,
  field: string,
  order: VerifiedOrderV1,
  includeIp: boolean,
): {
  stored: StoredFillIntentV1;
  verified: VerifiedFillIntentV1;
} {
  const row = persistedObject(raw, index, field);
  const verified = verifyFillIntentV1(row["intent"], row["auth"], order, {
    allowExpired: true,
  });
  if (row["intentDigest"] !== verified.intentDigest) invalidPersisted(index, `${field} digest`);
  const receivedAt = row["receivedAt"];
  if (typeof receivedAt !== "number" || !Number.isSafeInteger(receivedAt) || receivedAt < 0) {
    invalidPersisted(index, `${field} receive time`);
  }
  const rawIpHash = row["acceptorIpHash"];
  const acceptorIpHash =
    includeIp && typeof rawIpHash === "string" && TOKEN_HASH_RE.test(rawIpHash)
      ? rawIpHash
      : sha256Hex("federated-intent");
  if (includeIp && acceptorIpHash !== rawIpHash) invalidPersisted(index, `${field} source hash`);
  const releasedAt = row["releasedAt"];
  if (
    releasedAt !== undefined &&
    (typeof releasedAt !== "number" || !Number.isSafeInteger(releasedAt) || releasedAt < 0)
  ) {
    invalidPersisted(index, `${field} release time`);
  }
  const releaseSecret = row["releaseSecret"];
  if (
    releaseSecret !== undefined &&
    (typeof releaseSecret !== "string" || !BYTES32_RE.test(releaseSecret))
  ) {
    invalidPersisted(index, `${field} release secret`);
  }
  if ((releasedAt === undefined) !== (releaseSecret === undefined)) {
    invalidPersisted(index, `${field} incomplete release proof`);
  }
  if (
    releaseSecret !== undefined &&
    computeReleaseCommitment(
      order.orderDigest,
      verified.auth.nonce,
      releaseSecret,
    ) !== verified.intent.releaseCommitment
  ) {
    invalidPersisted(index, `${field} release commitment`);
  }
  return {
    stored: {
      intentDigest: verified.intentDigest,
      intent: verified.intent,
      auth: verified.auth,
      receivedAt,
      acceptorIpHash,
      ...(releasedAt === undefined ? {} : { releasedAt }),
      ...(releaseSecret === undefined ? {} : { releaseSecret }),
    },
    verified,
  };
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
  const rawFederationSourceHash = optionalMatchingString(
    row,
    index,
    "federationSourceHash",
    TOKEN_HASH_RE,
  );
  const acceptedAt = optionalSafeInteger(row, index, "acceptedAt");
  const releasedAt = optionalSafeInteger(row, index, "releasedAt");
  const releaseSecret = optionalMatchingString(row, index, "releaseSecret", BYTES32_RE);

  const order: Order = {
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
    ...(rawFederationSourceHash !== undefined
      ? { federationSourceHash: rawFederationSourceHash }
      : {}),
    ...(acceptedAt !== undefined ? { acceptedAt } : {}),
    ...(releasedAt !== undefined ? { releasedAt } : {}),
    ...(releaseSecret !== undefined ? { releaseSecret } : {}),
  };
  let portableOrder: VerifiedOrderV1 | undefined;
  if (row["makerAuth"] !== undefined) {
    const verified = verifyOrderV1(signedOrderBody(order), row["makerAuth"], {
      allowExpired: true,
    });
    if (verified.orderId !== order.id) {
      invalidPersisted(index, "signed order id");
    }
    order.makerAuth = verified.auth;
    const persistedDigest = row["orderDigest"];
    if (persistedDigest !== undefined && persistedDigest !== verified.orderDigest) {
      invalidPersisted(index, "signed order digest");
    }
    order.orderDigest = verified.orderDigest;
    portableOrder = verified;
    if (
      order.visibility === "public" &&
      order.federationSourceHash === undefined &&
      order.creatorIpHash === sha256Hex("federation")
    ) {
      order.federationSourceHash = sha256Hex("legacy-federation-source");
    }
  }
  if (order.federationSourceHash !== undefined && portableOrder === undefined) {
    invalidPersisted(index, "federation source without maker proof");
  }

  const hasProtocolState =
    row["orderDigest"] !== undefined ||
    row["fillIntents"] !== undefined ||
    row["selectedIntent"] !== undefined ||
    row["fill"] !== undefined ||
    row["fillAuth"] !== undefined ||
    row["cancelProof"] !== undefined ||
    row["cancelAuth"] !== undefined ||
    row["cancelDigest"] !== undefined ||
    row["conflicts"] !== undefined ||
    row["orderConflicts"] !== undefined ||
    row["equivocated"] !== undefined ||
    row["releaseSecret"] !== undefined;
  if (portableOrder === undefined && hasProtocolState) {
    invalidPersisted(index, "portable protocol state without maker proof");
  }
  if (portableOrder !== undefined) {
    const rawIntents = row["fillIntents"];
    if (rawIntents !== undefined) {
      if (!Array.isArray(rawIntents) || rawIntents.length > MAX_FILL_INTENTS_PER_ORDER) {
        invalidPersisted(index, "fill intents");
      }
      order.fillIntents = rawIntents.map(
        (intent, intentIndex) =>
          hydrateIntentProof(
            intent,
            index,
            `fill intent ${intentIndex}`,
            portableOrder,
            true,
          ).stored,
      );
      if (new Set(order.fillIntents.map((intent) => intent.intentDigest)).size !== order.fillIntents.length) {
        invalidPersisted(index, "duplicate fill intents");
      }
    }

    let selectedVerified: VerifiedFillIntentV1 | undefined;
    if (row["selectedIntent"] !== undefined) {
      const selected = hydrateIntentProof(
        row["selectedIntent"],
        index,
        "selected intent",
        portableOrder,
        false,
      );
      const {
        acceptorIpHash: _omit,
        releasedAt: _omit2,
        releaseSecret: _omit3,
        ...selectedIntent
      } = selected.stored;
      order.selectedIntent = selectedIntent;
      selectedVerified = selected.verified;
    }

    const hasAnyFillField =
      row["fill"] !== undefined || row["fillAuth"] !== undefined || row["fillDigest"] !== undefined;
    if (hasAnyFillField) {
      if (
        row["fill"] === undefined ||
        row["fillAuth"] === undefined ||
        row["fillDigest"] === undefined ||
        selectedVerified === undefined
      ) {
        invalidPersisted(index, "fill proof");
      }
      const fill = verifyFillV1(
        row["fill"],
        row["fillAuth"],
        portableOrder,
        selectedVerified,
        { allowExpired: true },
      );
      if (row["fillDigest"] !== fill.fillDigest) invalidPersisted(index, "fill digest");
      if (
        order.hashlock !== fill.fill.hashlock ||
        order.initiatorTimeout !== fill.fill.initiatorTimeout ||
        order.responderTimeout !== fill.fill.responderTimeout ||
        order.takerEthAccount !== fill.fill.takerEthAccount ||
        order.takerQrlAccount !== fill.fill.takerQrlAccount
      ) {
        invalidPersisted(index, "fill projection");
      }
      order.fill = fill.fill;
      order.fillAuth = fill.auth;
      order.fillDigest = fill.fillDigest;
    }

    const hasAnyCancelField =
      row["cancelProof"] !== undefined ||
      row["cancelAuth"] !== undefined ||
      row["cancelDigest"] !== undefined;
    if (hasAnyCancelField) {
      if (
        row["cancelProof"] === undefined ||
        row["cancelAuth"] === undefined ||
        row["cancelDigest"] === undefined
      ) {
        invalidPersisted(index, "cancel proof");
      }
      const cancel = verifyCancelV1(
        row["cancelProof"],
        row["cancelAuth"],
        portableOrder,
        { allowExpired: true },
      );
      if (row["cancelDigest"] !== cancel.cancelDigest) invalidPersisted(index, "cancel digest");
      order.cancelProof = cancel.cancel;
      order.cancelAuth = cancel.auth;
      order.cancelDigest = cancel.cancelDigest;
    }

    const rawTerminalConflicts = row["conflicts"];
    if (rawTerminalConflicts !== undefined) {
      if (!Array.isArray(rawTerminalConflicts) || rawTerminalConflicts.length > MAX_CONFLICT_PROOFS) {
        invalidPersisted(index, "terminal conflicts");
      }
      order.conflicts = rawTerminalConflicts.map((rawConflict, conflictIndex) => {
        const conflict = persistedObject(
          rawConflict,
          index,
          `terminal conflict ${conflictIndex}`,
        );
        if (conflict["kind"] === "fill-v1") {
          const intent = verifyFillIntentV1(
            conflict["intent"],
            conflict["intentAuth"],
            portableOrder,
            { allowExpired: true },
          );
          const fill = verifyFillV1(
            conflict["body"],
            conflict["auth"],
            portableOrder,
            intent,
            { allowExpired: true },
          );
          if (conflict["digest"] !== fill.fillDigest) {
            invalidPersisted(index, `terminal conflict ${conflictIndex} digest`);
          }
          return {
            kind: "fill-v1" as const,
            digest: fill.fillDigest,
            body: fill.fill,
            auth: fill.auth,
            intent: intent.intent,
            intentAuth: intent.auth,
          };
        }
        if (conflict["kind"] === "cancel-v1") {
          const cancel = verifyCancelV1(
            conflict["body"],
            conflict["auth"],
            portableOrder,
            { allowExpired: true },
          );
          if (conflict["digest"] !== cancel.cancelDigest) {
            invalidPersisted(index, `terminal conflict ${conflictIndex} digest`);
          }
          return {
            kind: "cancel-v1" as const,
            digest: cancel.cancelDigest,
            body: cancel.cancel,
            auth: cancel.auth,
          };
        }
        return invalidPersisted(index, `terminal conflict ${conflictIndex} kind`);
      });
      const conflictDigests = order.conflicts.map((conflict) => conflict.digest);
      if (
        new Set(conflictDigests).size !== conflictDigests.length ||
        conflictDigests.includes(order.fillDigest ?? "") ||
        conflictDigests.includes(order.cancelDigest ?? "")
      ) {
        invalidPersisted(index, "duplicate terminal conflicts");
      }
    }

    const rawOrderConflicts = row["orderConflicts"];
    if (rawOrderConflicts !== undefined) {
      if (!Array.isArray(rawOrderConflicts) || rawOrderConflicts.length > MAX_CONFLICT_PROOFS) {
        invalidPersisted(index, "order conflicts");
      }
      order.orderConflicts = rawOrderConflicts.map((rawConflict, conflictIndex) => {
        const conflict = persistedObject(rawConflict, index, `order conflict ${conflictIndex}`);
        const verified = verifyOrderV1(conflict["order"], conflict["auth"], {
          allowExpired: true,
        });
        if (verified.orderId !== order.id || conflict["orderDigest"] !== verified.orderDigest) {
          invalidPersisted(index, `order conflict ${conflictIndex} reference`);
        }
        return {
          orderDigest: verified.orderDigest,
          order: verified.order,
          auth: verified.auth,
        };
      });
      const conflictDigests = order.orderConflicts.map((conflict) => conflict.orderDigest);
      if (
        new Set(conflictDigests).size !== conflictDigests.length ||
        conflictDigests.includes(order.orderDigest ?? "")
      ) {
        invalidPersisted(index, "duplicate order conflicts");
      }
    }

    if (order.selectedIntent !== undefined && order.fill === undefined) {
      invalidPersisted(index, "selected intent without fill");
    }
    if (order.fill !== undefined && order.status !== "locking") {
      invalidPersisted(index, "fill status");
    }
    if (order.cancelProof !== undefined && order.fill === undefined && order.status !== "cancelled") {
      invalidPersisted(index, "cancel status");
    }
    if (order.releaseSecret !== undefined) {
      if (
        order.releasedAt === undefined ||
        order.fill === undefined ||
        order.selectedIntent === undefined ||
        computeReleaseCommitment(
          portableOrder.orderDigest,
          order.selectedIntent.auth.nonce,
          order.releaseSecret,
        ) !== order.fill.releaseCommitment
      ) {
        invalidPersisted(index, "release proof");
      }
    } else if (order.fill !== undefined && order.releasedAt !== undefined) {
      invalidPersisted(index, "missing release proof");
    }

    if (
      row["equivocated"] === true ||
      (order.conflicts?.length ?? 0) > 0 ||
      (order.orderConflicts?.length ?? 0) > 0 ||
      (order.fill !== undefined && order.cancelProof !== undefined)
    ) {
      order.equivocated = true;
    }
  }
  return order;
}

export class OrderStore {
  private orders = new Map<string, Order>();
  /** Last maker heartbeat per order id. Deliberately not persisted. */
  private seenAt = new Map<string, number>();
  private listeners: Array<() => void> = [];
  private federationListeners: Array<(event: FederationEvent) => void> = [];
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

  subscribeFederation(fn: (event: FederationEvent) => void): void {
    this.federationListeners.push(fn);
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }

  private publish(event: FederationEvent): void {
    for (const listener of this.federationListeners) listener(event);
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
    let publicPortableOrders = 0;
    let federatedPublicPortableOrders = 0;
    const federatedOrdersBySource = new Map<string, number>();
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
      if (order.visibility === "public" && usesPortableTerminalProtocol(order)) {
        publicPortableOrders += 1;
        if (publicPortableOrders > MAX_PUBLIC_PORTABLE_ORDERS) {
          throw new Error(
            `order data file contains more than ${MAX_PUBLIC_PORTABLE_ORDERS} portable public orders`,
          );
        }
        if (order.federationSourceHash !== undefined) {
          federatedPublicPortableOrders += 1;
          if (federatedPublicPortableOrders > MAX_FEDERATED_PUBLIC_PORTABLE_ORDERS) {
            throw new Error(
              `order data file contains more than ${MAX_FEDERATED_PUBLIC_PORTABLE_ORDERS} federated portable public orders`,
            );
          }
          const sourceCount = (federatedOrdersBySource.get(order.federationSourceHash) ?? 0) + 1;
          if (sourceCount > MAX_PUBLIC_PORTABLE_ORDERS_PER_FEDERATION_PEER) {
            throw new Error(
              `order data file contains more than ${MAX_PUBLIC_PORTABLE_ORDERS_PER_FEDERATION_PEER} portable public orders from one federation source`,
            );
          }
          federatedOrdersBySource.set(order.federationSourceHash, sourceCount);
        }
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
      federationSourceHash: _omitFederationSource,
      acceptedAt: _omit5,
      shareTokenHash: _omit6,
      fillIntents: _omit7,
      conflicts,
      orderConflicts,
      releasedAt,
      releaseSecret: _omit8,
      makerAuth,
      orderDigest,
      ...rest
    } = order;
    return {
      ...rest,
      ...(usesPortableTerminalProtocol(order) && makerAuth !== undefined
        ? { makerAuth, orderDigest }
        : {}),
      released: releasedAt !== undefined,
      makerSeen: this.isSeen(order, nowS()),
      ...((conflicts?.length ?? 0) + (orderConflicts?.length ?? 0) > 0
        ? {
            conflictDigests: [
              ...(orderConflicts ?? []).map((conflict) => conflict.orderDigest),
              ...(conflicts ?? []).map((conflict) => conflict.digest),
            ],
          }
        : {}),
    };
  }

  /** Expire stale records. Chain state is the source of truth for funds;
   *  this only keeps the book readable. */
  private sweep(): void {
    const now = nowS();
    let dirty = false;
    for (const order of this.orders.values()) {
      if (order.fillIntents !== undefined) {
        const retained = order.fillIntents.filter(
          (intent) => intent.auth.expiresAt + SIGNED_INTENT_RETENTION_S > now,
        );
        if (retained.length !== order.fillIntents.length) {
          order.fillIntents = retained;
          dirty = true;
        }
      }
      const age = now - order.updatedAt;
      if (
        (order.status === "open" &&
          (age > OPEN_TTL_S ||
            (order.makerAuth !== undefined && now >= order.makerAuth.expiresAt))) ||
        (order.status === "accepted" && age > ACCEPTED_TTL_S)
      ) {
        order.status = "cancelled";
        order.updatedAt = now;
        dirty = true;
      } else if (
        (order.status === "cancelled" &&
          (order.makerAuth === undefined
            ? age > CANCELLED_TTL_S
            : now > order.makerAuth.expiresAt + SIGNED_TERMINAL_GRACE_S &&
              age > SIGNED_TERMINAL_GRACE_S)) ||
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
      .filter((o) => o.equivocated !== true)
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
      order.shareTokenHash !== undefined &&
      (order.makerAuth === undefined
        ? legacyTokenMatches(order.shareTokenHash, shareToken)
        : capabilityMatches(order.shareTokenHash, shareToken, computeShareTokenCommitment))
    );
  }

  create(body: Record<string, unknown>, makerIp = "unknown"): {
    order: PublicOrder;
    makerToken: string;
    shareToken?: string;
  } {
    return this.createInternal(body, makerIp);
  }

  createVerified(
    verified: VerifiedOrderV1,
    rawCapabilities: { makerToken: unknown; shareToken?: unknown },
    makerIp = "unknown",
  ): {
    order: PublicOrder;
    makerToken: string;
    shareToken?: string;
  } {
    const capabilities = signedCreateCapabilities(verified, rawCapabilities);
    return this.createInternal(
      verified.order,
      makerIp,
      verified,
      false,
      capabilities,
    );
  }

  importVerifiedOrder(
    verified: VerifiedOrderV1,
    federationSource = "unknown",
  ): PublicOrder {
    this.sweep();
    if (verified.terms.visibility !== "public") {
      throw new ApiError(400, "private signed orders are origin-only");
    }
    const existing = this.orders.get(verified.orderId);
    if (existing !== undefined) {
      if (existing.orderDigest === verified.orderDigest) return this.pub(existing);
      const conflicts = existing.orderConflicts ?? [];
      if (!conflicts.some((conflict) => conflict.orderDigest === verified.orderDigest)) {
        conflicts.push({
          orderDigest: verified.orderDigest,
          order: verified.order,
          auth: verified.auth,
        });
        while (conflicts.length > MAX_CONFLICT_PROOFS) conflicts.shift();
        existing.orderConflicts = conflicts;
        existing.equivocated = true;
        if (existing.status === "open" || existing.status === "accepted") {
          existing.status = "cancelled";
        }
        existing.updatedAt = nowS();
        this.persist();
        if (existing.visibility === "public") {
          this.publish({
            kind: "order-v1",
            payload: { order: verified.order, auth: verified.auth },
          });
        }
      }
      return this.pub(existing);
    }
    if (
      federationSource.length < 1 ||
      federationSource.length > 64 ||
      !/^[a-z0-9][a-z0-9-]*$/.test(federationSource)
    ) {
      throw new ApiError(400, "federation source id is invalid");
    }
    return this.createInternal(
      verified.order,
      `federation:${federationSource}`,
      verified,
      true,
      undefined,
      federationSource,
    ).order;
  }

  private createInternal(
    body: Record<string, unknown>,
    makerIp: string,
    verified?: VerifiedOrderV1,
    federated = false,
    capabilities?: { makerToken: string; shareToken?: string },
    federationSource?: string,
  ): {
    order: PublicOrder;
    makerToken: string;
    shareToken?: string;
  } {
    this.sweep();
    if (verified !== undefined) {
      const existing = this.orders.get(verified.orderId);
      if (existing !== undefined) {
        if (existing.orderDigest !== verified.orderDigest) {
          throw new ApiError(409, "order id conflicts with another signed order");
        }
        if (federated || capabilities === undefined) {
          return { order: this.pub(existing), makerToken: "" };
        }
        const makerCommitment = verified.auth.makerTokenCommitment;
        const shareCommitment = verified.auth.shareTokenCommitment;
        if (
          !fixedHexMatches(existing.makerTokenHash, makerCommitment.slice(2)) ||
          (existing.visibility === "private" &&
            (existing.shareTokenHash === undefined ||
              !fixedHexMatches(existing.shareTokenHash, shareCommitment.slice(2))))
        ) {
          throw new ApiError(409, "stored order capabilities do not match the signed proof");
        }
        this.seenAt.set(existing.id, nowS());
        return {
          order: this.pub(existing),
          makerToken: capabilities.makerToken,
          ...(capabilities.shareToken === undefined
            ? {}
            : { shareToken: capabilities.shareToken }),
        };
      }
    }
    const retainedOrders = [...this.orders.values()];
    if (retainedOrders.length >= MAX_RETAINED_ORDERS) {
      throw new ApiError(
        503,
        "order book retained-state capacity is full",
        "transient_capacity",
      );
    }
    const openOrders = [...this.orders.values()].filter((o) => o.status === "open");
    if (openOrders.length >= MAX_OPEN_ORDERS) {
      throw new ApiError(503, "order book is full", "transient_capacity");
    }

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
      throw new ApiError(
        429,
        "maker already has too many open orders",
        "transient_capacity",
      );
    }
    const makerRetainedCount = retainedOrders.filter(
      (order) =>
        order.makerEthAccount.toLowerCase() === makerEthAccount.toLowerCase() &&
        order.makerQrlAccount.toLowerCase() === makerQrlAccount.toLowerCase(),
    ).length;
    if (makerRetainedCount >= MAX_RETAINED_ORDERS_PER_MAKER) {
      throw new ApiError(
        429,
        "maker already has too many retained order artifacts",
        "transient_capacity",
      );
    }
    const creatorIpHash = sha256Hex(makerIp);
    const sourceOpenCount = openOrders.filter(
      (order) => order.creatorIpHash === creatorIpHash,
    ).length;
    if (!federated && sourceOpenCount >= MAX_OPEN_ORDERS_PER_IP) {
      throw new ApiError(
        429,
        "source already has too many open orders",
        "transient_capacity",
      );
    }
    const sourceRetainedCount = retainedOrders.filter(
      (order) => order.creatorIpHash === creatorIpHash,
    ).length;
    const sourceRetainedLimit = federated
      ? MAX_RETAINED_FEDERATED_ORDERS
      : MAX_RETAINED_ORDERS_PER_IP;
    if (sourceRetainedCount >= sourceRetainedLimit) {
      throw new ApiError(
        429,
        "source already has too many retained order artifacts",
        "transient_capacity",
      );
    }

    const rawVisibility = body["visibility"];
    if (rawVisibility !== undefined && rawVisibility !== "public" && rawVisibility !== "private") {
      throw new ApiError(400, "visibility must be public or private");
    }
    const visibility: Visibility = rawVisibility === "private" ? "private" : "public";
    if (
      verified !== undefined &&
      visibility === "public" &&
      retainedOrders.filter(
        (order) =>
          order.visibility === "public" && usesPortableTerminalProtocol(order),
      ).length >= MAX_PUBLIC_PORTABLE_ORDERS
    ) {
      throw new ApiError(
        503,
        "portable public-order capacity is full",
        "transient_capacity",
      );
    }
    if (verified !== undefined && visibility === "public" && federated) {
      const federatedOrders = retainedOrders.filter(
        (order) =>
          order.visibility === "public" &&
          usesPortableTerminalProtocol(order) &&
          order.federationSourceHash !== undefined,
      );
      if (federatedOrders.length >= MAX_FEDERATED_PUBLIC_PORTABLE_ORDERS) {
        throw new ApiError(
          503,
          "federated portable public-order capacity is full",
          "transient_capacity",
        );
      }
      const sourceHash = sha256Hex(`federation:${federationSource ?? "unknown"}`);
      if (
        federatedOrders.filter((order) => order.federationSourceHash === sourceHash).length >=
        MAX_PUBLIC_PORTABLE_ORDERS_PER_FEDERATION_PEER
      ) {
        throw new ApiError(
          429,
          "federation source already has too many portable public orders",
          "transient_capacity",
        );
      }
    }
    // The share token is the capability that finds and takes the order
    // (shared out of band by the maker); the optional taker restriction
    // pins the counterparty even if the link leaks. Neither makes sense
    // on a publicly listed order.
    let shareToken: string | undefined;
    let allowedTakerEth: string | undefined;
    let allowedTakerQrl: string | undefined;
    if (visibility === "private") {
      shareToken = verified === undefined
        ? randomBytes(32).toString("hex")
        : capabilities?.shareToken;
      if (shareToken === undefined && !federated) {
        throw new ApiError(400, "private signed order shareToken is missing");
      }
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
      if (!federated && initiatorTimeout < now + PRELOCK_MIN_T1_S) {
        throw new ApiError(400, "prelock.initiatorTimeout is too soon for a takeable listing");
      }
      if (!federated && initiatorTimeout > now + PRELOCK_MAX_T1_S) {
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

    const makerToken = verified === undefined
      ? randomBytes(32).toString("hex")
      : capabilities?.makerToken ?? "";
    const id = verified?.orderId ?? randomBytes(8).toString("hex");
    if (this.orders.has(id)) throw new ApiError(409, "order already exists");
    const signedMakerCommitment = verified?.auth.makerTokenCommitment;
    const signedShareCommitment = verified?.auth.shareTokenCommitment;
    if (!federated && verified !== undefined) {
      const makerHash = signedMakerCommitment!.slice(2);
      const shareHash = signedShareCommitment!.slice(2);
      if (
        retainedOrders.some(
          (candidate) =>
            candidate.id !== id &&
            (candidate.makerTokenHash === makerHash ||
              candidate.shareTokenHash === shareHash),
        )
      ) {
        throw new ApiError(409, "signed order capability commitment is already in use");
      }
    }
    const order: Order = {
      id,
      direction,
      asset: asset.symbol,
      visibility,
      ...(visibility === "private"
        ? {
            shareTokenHash:
              verified === undefined
                ? sha256Hex(shareToken!)
                : signedShareCommitment!.slice(2),
          }
        : {}),
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
      makerTokenHash:
        verified === undefined
          ? sha256Hex(makerToken)
          : signedMakerCommitment!.slice(2),
      creatorIpHash,
      ...(federated
        ? { federationSourceHash: sha256Hex(`federation:${federationSource ?? "unknown"}`) }
        : {}),
      ...(verified !== undefined
        ? { makerAuth: verified.auth, orderDigest: verified.orderDigest, fillIntents: [] }
        : {}),
    };
    this.orders.set(order.id, order);
    if (!federated) this.seenAt.set(order.id, now); // local creation proves presence
    this.persist();
    if (verified !== undefined && visibility === "public") {
      this.publish({
        kind: "order-v1",
        payload: { order: verified.order, auth: verified.auth },
      });
    }
    return {
      order: this.pub(order),
      makerToken,
      ...(shareToken !== undefined ? { shareToken } : {}),
    };
  }

  submitFillIntent(
    id: string,
    rawIntent: unknown,
    rawAuth: unknown,
    takerIp: string,
    shareToken?: unknown,
  ): PublicFillIntentV1 {
    this.sweep();
    const order = this.orders.get(id);
    if (!order) throw new ApiError(404, "order not found");
    if (order.visibility === "private" && !this.shareAuthorized(order, shareToken)) {
      throw new ApiError(404, "order not found");
    }
    if (order.makerAuth === undefined) {
      throw new ApiError(409, "legacy orders use the accept endpoint");
    }
    if (!usesPortableTerminalProtocol(order)) {
      throw new ApiError(409, "legacy orders use the accept endpoint");
    }
    const verifiedOrder = verifiedSignedOrder(order);
    const verified = verifyFillIntentV1(rawIntent, rawAuth, verifiedOrder);
    const replay = (order.fillIntents ?? []).find(
      (intent) => intent.intentDigest === verified.intentDigest,
    );
    if (replay !== undefined) {
      const {
        acceptorIpHash: _omit,
        releasedAt: _omit2,
        releaseSecret: _omit3,
        ...publicIntent
      } = replay;
      return publicIntent;
    }
    if (order.status !== "open" || order.equivocated === true) {
      throw new ApiError(409, "order is no longer open");
    }
    if (!this.hasRunway(order, nowS())) {
      throw new ApiError(409, "this pre-funded order has too little time left to swap safely");
    }
    return this.storeFillIntent(order, verified, takerIp, false);
  }

  importFillIntent(
    id: string,
    rawIntent: unknown,
    rawAuth: unknown,
  ): PublicFillIntentV1 {
    this.sweep();
    const order = this.orders.get(id);
    if (!order || order.visibility !== "public" || !usesPortableTerminalProtocol(order)) {
      throw new ApiError(
        409,
        "referenced public order is unavailable",
        "federation_dependency",
      );
    }
    const verified = verifyFillIntentV1(rawIntent, rawAuth, verifiedSignedOrder(order), {
      allowExpired: true,
    });
    const replay = (order.fillIntents ?? []).find(
      (intent) => intent.intentDigest === verified.intentDigest,
    );
    if (replay !== undefined) {
      const {
        acceptorIpHash: _omit,
        releasedAt: _omit2,
        releaseSecret: _omit3,
        ...publicIntent
      } = replay;
      return publicIntent;
    }
    if (
      (order.status !== "open" &&
        !(order.status === "cancelled" && order.cancelProof === undefined)) ||
      order.equivocated === true
    ) {
      throw new ApiError(409, "order is no longer open");
    }
    return this.storeFillIntent(order, verified, "federation", true);
  }

  private storeFillIntent(
    order: Order,
    verified: VerifiedFillIntentV1,
    takerIp: string,
    federated: boolean,
  ): PublicFillIntentV1 {
    const intents = order.fillIntents ?? [];
    const replay = intents.find((intent) => intent.intentDigest === verified.intentDigest);
    if (replay !== undefined) {
      const {
        acceptorIpHash: _omit,
        releasedAt: _omit2,
        releaseSecret: _omit3,
        ...publicIntent
      } = replay;
      return publicIntent;
    }
    if (intents.some((intent) => intent.auth.nonce === verified.auth.nonce)) {
      throw new ApiError(409, "fill intent nonce conflicts with another signed intent");
    }
    if (intents.length >= MAX_FILL_INTENTS_PER_ORDER) {
      throw new ApiError(
        429,
        "this order already has too many pending fill intents",
        "transient_capacity",
      );
    }

    const now = nowS();
    const ipHash = sha256Hex(takerIp);
    if (!federated) {
      const activeIntentCount = [...this.orders.values()].reduce(
        (count, candidate) =>
          count +
          (candidate.fillIntents ?? []).filter(
            (intent) =>
              intent.acceptorIpHash === ipHash &&
              intent.releasedAt === undefined &&
              intent.auth.expiresAt > now,
          ).length,
        0,
      );
      if (activeIntentCount >= MAX_CONCURRENT_TAKES_PER_IP) {
        throw new ApiError(429, "you already have fill requests in progress; finish or let them expire");
      }
      const recentIntentCount = [...this.orders.values()].reduce(
        (count, candidate) =>
          count +
          (candidate.fillIntents ?? []).filter(
            (intent) =>
              intent.acceptorIpHash === ipHash && intent.receivedAt > now - TAKE_WINDOW_S,
          ).length,
        0,
      );
      if (recentIntentCount >= MAX_TAKES_PER_IP_PER_DAY) {
        throw new ApiError(429, "daily fill intent limit reached; leave some liquidity for others");
      }
    }

    const stored: StoredFillIntentV1 = {
      intentDigest: verified.intentDigest,
      intent: verified.intent,
      auth: verified.auth,
      receivedAt: now,
      acceptorIpHash: ipHash,
    };
    intents.push(stored);
    order.fillIntents = intents;
    order.updatedAt = now;
    this.persist();
    if (order.visibility === "public") {
      this.publish({
        kind: "fill-intent-v1",
        payload: {
          orderId: order.id,
          intent: verified.intent,
          auth: verified.auth,
        },
      });
    }
    const {
      acceptorIpHash: _omit,
      releasedAt: _omit2,
      releaseSecret: _omit3,
      ...publicIntent
    } = stored;
    return publicIntent;
  }

  listFillIntents(id: string, makerToken?: unknown): PublicFillIntentV1[] {
    this.sweep();
    const order = this.orders.get(id);
    if (!order) throw new ApiError(404, "order not found");
    if (!usesPortableTerminalProtocol(order)) throw new ApiError(409, "order is not portable");
    if (order.visibility === "private") {
      this.authorized(order, { token: makerToken });
    }
    if (order.status !== "open" || order.equivocated === true) return [];
    const now = nowS();
    return (order.fillIntents ?? [])
      .filter(
        (intent) =>
          intent.releasedAt === undefined &&
          intent.auth.issuedAt <= now &&
          intent.auth.expiresAt > now,
      )
      .sort(
        (left, right) =>
          left.auth.issuedAt - right.auth.issuedAt ||
          left.intentDigest.localeCompare(right.intentDigest),
      )
      .map(
        ({
          acceptorIpHash: _omit,
          releasedAt: _omit2,
          releaseSecret: _omit3,
          ...intent
        }) => intent,
      );
  }

  private rememberTerminalConflict(
    order: Order,
    evidence: TerminalConflictEvidence,
  ): boolean {
    if (
      evidence.digest === order.fillDigest ||
      evidence.digest === order.cancelDigest ||
      (order.conflicts ?? []).some((conflict) => conflict.digest === evidence.digest)
    ) {
      return false;
    }
    const conflicts = order.conflicts ?? [];
    conflicts.push(evidence);
    while (conflicts.length > MAX_CONFLICT_PROOFS) conflicts.shift();
    order.conflicts = conflicts;
    order.equivocated = true;
    order.updatedAt = nowS();
    return true;
  }

  fillOrder(
    id: string,
    rawFill: unknown,
    rawAuth: unknown,
    rawIntent: unknown,
    rawIntentAuth: unknown,
    makerToken?: unknown,
  ): PublicOrder {
    return this.applyFill(id, rawFill, rawAuth, rawIntent, rawIntentAuth, {
      federated: false,
      ...(makerToken === undefined ? {} : { makerToken }),
    });
  }

  importFill(
    id: string,
    rawFill: unknown,
    rawAuth: unknown,
    rawIntent: unknown,
    rawIntentAuth: unknown,
  ): PublicOrder {
    return this.applyFill(id, rawFill, rawAuth, rawIntent, rawIntentAuth, {
      federated: true,
    });
  }

  private applyFill(
    id: string,
    rawFill: unknown,
    rawAuth: unknown,
    rawIntent: unknown,
    rawIntentAuth: unknown,
    options: { federated: boolean; makerToken?: unknown },
  ): PublicOrder {
    this.sweep();
    const order = this.orders.get(id);
    if (!order) {
      throw new ApiError(
        options.federated ? 409 : 404,
        "order not found",
        options.federated ? "federation_dependency" : undefined,
      );
    }
    if (options.federated && order.visibility !== "public") {
      throw new ApiError(409, "private signed orders are origin-only");
    }
    if (!options.federated && order.visibility === "private") {
      this.authorized(order, { token: options.makerToken });
    }
    if (!usesPortableTerminalProtocol(order)) {
      throw new ApiError(409, "legacy orders use the hashlock endpoint");
    }

    const verifiedOrder = referencedSignedOrderVariant(order, rawFill);
    // FillV1 proves it was issued while the short-lived intent was valid.
    // Keep accepting that historical prerequisite through the fill's own
    // live respondBy window and during federated replay.
    const intent = verifyFillIntentV1(rawIntent, rawIntentAuth, verifiedOrder, {
      allowExpired: true,
    });
    const fill = verifyFillV1(rawFill, rawAuth, verifiedOrder, intent, {
      allowExpired: options.federated,
    });
    const event: FederationEvent = {
      kind: "fill-v1",
      payload: {
        orderId: order.id,
        fill: fill.fill,
        auth: fill.auth,
        intent: intent.intent,
        intentAuth: intent.auth,
      },
    };

    if (order.fillDigest === fill.fillDigest) return this.pub(order);
    if (order.fillDigest !== undefined || order.cancelDigest !== undefined) {
      if (
        this.rememberTerminalConflict(order, {
          kind: "fill-v1",
          digest: fill.fillDigest,
          body: fill.fill,
          auth: fill.auth,
          intent: intent.intent,
          intentAuth: intent.auth,
        })
      ) {
        this.persist();
        if (order.visibility === "public") this.publish(event);
      }
      return this.pub(order);
    }
    if (
      order.status !== "open" &&
      !(options.federated && order.status === "cancelled" && order.cancelProof === undefined)
    ) {
      throw new ApiError(409, "order is no longer open");
    }

    const storedIntent = (order.fillIntents ?? []).find(
      (candidate) => candidate.intentDigest === intent.intentDigest,
    );
    const selectedSource: StoredFillIntentV1 =
      storedIntent ?? {
        intentDigest: intent.intentDigest,
        intent: intent.intent,
        auth: intent.auth,
        receivedAt: nowS(),
        acceptorIpHash: sha256Hex("federated-intent"),
      };
    const {
      acceptorIpHash,
      releasedAt: selectedReleasedAt,
      releaseSecret: selectedReleaseSecret,
      ...selectedIntent
    } = selectedSource;
    const now = nowS();
    order.fill = fill.fill;
    order.fillAuth = fill.auth;
    order.fillDigest = fill.fillDigest;
    order.selectedIntent = selectedIntent;
    order.takerEthAccount = fill.fill.takerEthAccount;
    order.takerQrlAccount = fill.fill.takerQrlAccount;
    order.hashlock = fill.fill.hashlock;
    order.initiatorTimeout = fill.fill.initiatorTimeout;
    order.responderTimeout = fill.fill.responderTimeout;
    order.status = "locking";
    order.acceptorIpHash = acceptorIpHash;
    order.acceptedAt = fill.auth.issuedAt;
    order.updatedAt = now;
    delete order.takerTokenHash;
    if (selectedReleasedAt !== undefined && selectedReleaseSecret !== undefined) {
      order.releasedAt = selectedReleasedAt;
      order.releaseSecret = selectedReleaseSecret;
    } else {
      delete order.releasedAt;
      delete order.releaseSecret;
    }
    this.persist();
    if (order.visibility === "public") this.publish(event);
    return this.pub(order);
  }

  cancelSigned(
    id: string,
    rawCancel: unknown,
    rawAuth: unknown,
    makerToken?: unknown,
  ): PublicOrder {
    return this.applySignedCancel(id, rawCancel, rawAuth, {
      federated: false,
      ...(makerToken === undefined ? {} : { makerToken }),
    });
  }

  importSignedCancel(id: string, rawCancel: unknown, rawAuth: unknown): PublicOrder {
    return this.applySignedCancel(id, rawCancel, rawAuth, { federated: true });
  }

  private applySignedCancel(
    id: string,
    rawCancel: unknown,
    rawAuth: unknown,
    options: { federated: boolean; makerToken?: unknown },
  ): PublicOrder {
    this.sweep();
    const order = this.orders.get(id);
    if (!order) {
      throw new ApiError(
        options.federated ? 409 : 404,
        "order not found",
        options.federated ? "federation_dependency" : undefined,
      );
    }
    if (options.federated && order.visibility !== "public") {
      throw new ApiError(409, "private signed orders are origin-only");
    }
    if (!options.federated && order.visibility === "private") {
      this.authorized(order, { token: options.makerToken });
    }
    if (!usesPortableTerminalProtocol(order)) throw new ApiError(409, "order is not portable");
    const cancel = verifyCancelV1(
      rawCancel,
      rawAuth,
      referencedSignedOrderVariant(order, rawCancel),
      {
        allowExpired: options.federated,
      },
    );
    const event: FederationEvent = {
      kind: "cancel-v1",
      payload: { orderId: order.id, cancel: cancel.cancel, auth: cancel.auth },
    };
    if (order.cancelDigest === cancel.cancelDigest) return this.pub(order);
    if (order.fillDigest !== undefined || order.cancelDigest !== undefined) {
      if (
        this.rememberTerminalConflict(order, {
          kind: "cancel-v1",
          digest: cancel.cancelDigest,
          body: cancel.cancel,
          auth: cancel.auth,
        })
      ) {
        this.persist();
        if (order.visibility === "public") this.publish(event);
      }
      return this.pub(order);
    }
    order.cancelProof = cancel.cancel;
    order.cancelAuth = cancel.auth;
    order.cancelDigest = cancel.cancelDigest;
    order.status = "cancelled";
    order.updatedAt = nowS();
    this.persist();
    if (order.visibility === "public") this.publish(event);
    return this.pub(order);
  }

  federationSnapshot(): FederationEvent[] {
    this.sweep();
    const now = nowS();
    const events: FederationEvent[] = [];
    const orders = [...this.orders.values()]
      .filter(
        (order) => order.visibility === "public" && usesPortableTerminalProtocol(order),
      )
      .sort((left, right) => left.id.localeCompare(right.id));
    for (const order of orders) {
      const makerAuth = order.makerAuth;
      if (makerAuth === undefined) continue;
      events.push({
        kind: "order-v1",
        payload: { order: signedOrderBody(order), auth: makerAuth },
      });
      for (const conflict of order.orderConflicts ?? []) {
        events.push({
          kind: "order-v1",
          payload: { order: conflict.order, auth: conflict.auth },
        });
      }
      for (const intent of order.fillIntents ?? []) {
        if (intent.auth.expiresAt + SIGNED_INTENT_RETENTION_S <= now) continue;
        events.push({
          kind: "fill-intent-v1",
          payload: { orderId: order.id, intent: intent.intent, auth: intent.auth },
        });
        if (intent.releaseSecret !== undefined) {
          events.push({
            kind: "release-v1",
            payload: {
              orderId: order.id,
              intentDigest: intent.intentDigest,
              releaseSecret: intent.releaseSecret,
            },
          });
        }
      }
      if (
        order.fill !== undefined &&
        order.fillAuth !== undefined &&
        order.selectedIntent !== undefined
      ) {
        events.push({
          kind: "fill-v1",
          payload: {
            orderId: order.id,
            fill: order.fill,
            auth: order.fillAuth,
            intent: order.selectedIntent.intent,
            intentAuth: order.selectedIntent.auth,
          },
        });
      } else if (order.cancelProof !== undefined && order.cancelAuth !== undefined) {
        events.push({
          kind: "cancel-v1",
          payload: { orderId: order.id, cancel: order.cancelProof, auth: order.cancelAuth },
        });
      }
      for (const conflict of order.conflicts ?? []) {
        events.push(
          conflict.kind === "fill-v1"
            ? {
                kind: "fill-v1",
                payload: {
                  orderId: order.id,
                  fill: conflict.body,
                  auth: conflict.auth,
                  intent: conflict.intent,
                  intentAuth: conflict.intentAuth,
                },
              }
            : {
                kind: "cancel-v1",
                payload: {
                  orderId: order.id,
                  cancel: conflict.body,
                  auth: conflict.auth,
                },
              },
        );
      }
      if (
        order.releaseSecret !== undefined &&
        order.fillDigest !== undefined &&
        order.releasedAt !== undefined
      ) {
        events.push({
          kind: "release-v1",
          payload: {
            orderId: order.id,
            fillDigest: order.fillDigest,
            releaseSecret: order.releaseSecret,
          },
        });
      }
    }
    return events;
  }

  applyFederationEvent(event: FederationEvent, federationSource = "unknown"): void {
    const payload = event.payload;
    if (event.kind === "order-v1") {
      exactPayload(payload, ["order", "auth"], "federated order event");
      const verified = verifyOrderV1(payload["order"], payload["auth"], {
        allowExpired: true,
      });
      this.importVerifiedOrder(verified, federationSource);
      return;
    }

    const orderId = payload["orderId"];
    if (typeof orderId !== "string" || !ORDER_ID_RE.test(orderId)) {
      throw new ApiError(400, "federation event has an invalid order id");
    }
    if (event.kind === "fill-intent-v1") {
      exactPayload(
        payload,
        ["orderId", "intent", "auth"],
        "federated fill intent event",
      );
      this.importFillIntent(orderId, payload["intent"], payload["auth"]);
      return;
    }
    if (event.kind === "fill-v1") {
      exactPayload(
        payload,
        ["orderId", "fill", "auth", "intent", "intentAuth"],
        "federated fill event",
      );
      this.importFill(
        orderId,
        payload["fill"],
        payload["auth"],
        payload["intent"],
        payload["intentAuth"],
      );
      return;
    }
    if (event.kind === "cancel-v1") {
      exactPayload(
        payload,
        ["orderId", "cancel", "auth"],
        "federated cancel event",
      );
      this.importSignedCancel(orderId, payload["cancel"], payload["auth"]);
      return;
    }
    const hasFillDigest = payload["fillDigest"] !== undefined;
    exactPayload(
      payload,
      ["orderId", hasFillDigest ? "fillDigest" : "intentDigest", "releaseSecret"],
      "federated release event",
    );
    this.importRelease(orderId, {
      ...(hasFillDigest
        ? { fillDigest: payload["fillDigest"] }
        : { intentDigest: payload["intentDigest"] }),
      releaseSecret: payload["releaseSecret"],
    });
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
    if (usesPortableTerminalProtocol(order)) {
      throw new ApiError(409, "signed orders require a FillIntentV1 request");
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
        !usesPortableTerminalProtocol(o) &&
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
    const valid =
      order.makerAuth === undefined
        ? legacyTokenMatches(order.makerTokenHash, token)
        : capabilityMatches(
            order.makerTokenHash,
            token,
            computeMakerTokenCommitment,
          );
    if (!valid) {
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
    if (usesPortableTerminalProtocol(order)) {
      throw new ApiError(409, "signed orders require a FillV1 proof");
    }
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
    if (usesPortableTerminalProtocol(order)) {
      return this.releasePortable(order, body, false);
    }
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

  importRelease(id: string, body: Record<string, unknown>): PublicOrder {
    this.sweep();
    const order = this.orders.get(id);
    if (!order || order.visibility !== "public" || !usesPortableTerminalProtocol(order)) {
      throw new ApiError(
        409,
        "referenced public order is unavailable",
        "federation_dependency",
      );
    }
    return this.releasePortable(order, body, true);
  }

  private releasePortable(
    order: Order,
    body: Record<string, unknown>,
    federated: boolean,
  ): PublicOrder {
    if (federated && order.visibility !== "public") {
      throw new ApiError(409, "private signed orders are origin-only");
    }
    if (!federated && order.visibility === "private") {
      if (!this.shareAuthorized(order, body["shareToken"])) {
        throw new ApiError(404, "order not found");
      }
    }
    const hasFillDigest = body["fillDigest"] !== undefined;
    const hasIntentDigest = body["intentDigest"] !== undefined;
    if (hasFillDigest === hasIntentDigest) {
      throw new ApiError(400, "release must identify exactly one fill or fill intent");
    }
    exactPayload(
      body,
      [
        hasFillDigest ? "fillDigest" : "intentDigest",
        "releaseSecret",
        ...(order.visibility === "private" && !federated ? ["shareToken"] : []),
      ],
      "release",
    );
    const releaseSecret = body["releaseSecret"];
    if (typeof releaseSecret !== "string" || !BYTES32_RE.test(releaseSecret)) {
      throw new ApiError(400, "releaseSecret must be 32 bytes of lowercase hex");
    }
    const orderDigestValue = order.orderDigest;
    if (orderDigestValue === undefined) throw new ApiError(409, "order is not portable");
    const now = nowS();

    let event: FederationEvent;
    if (hasFillDigest) {
      const digest = body["fillDigest"];
      if (
        typeof digest !== "string" ||
        !BYTES32_RE.test(digest) ||
        order.fillDigest !== digest ||
        order.fill === undefined ||
        order.selectedIntent === undefined
      ) {
        throw new ApiError(
          409,
          "referenced fill is unavailable",
          "federation_dependency",
        );
      }
      const expected = computeReleaseCommitment(
        orderDigestValue,
        order.selectedIntent.auth.nonce,
        releaseSecret,
      );
      if (expected !== order.fill.releaseCommitment) {
        throw new ApiError(403, "release secret does not match the signed fill");
      }
      if (order.releaseSecret === releaseSecret && order.releasedAt !== undefined) {
        return this.pub(order);
      }
      order.releaseSecret = releaseSecret;
      order.releasedAt = now;
      order.updatedAt = now;
      event = {
        kind: "release-v1",
        payload: { orderId: order.id, fillDigest: digest, releaseSecret },
      };
    } else {
      const digest = body["intentDigest"];
      if (typeof digest !== "string" || !BYTES32_RE.test(digest)) {
        throw new ApiError(400, "intentDigest must be 32 bytes of lowercase hex");
      }
      const storedIntent = (order.fillIntents ?? []).find(
        (candidate) => candidate.intentDigest === digest,
      );
      const selectedIntent =
        order.selectedIntent?.intentDigest === digest ? order.selectedIntent : undefined;
      const intent = storedIntent ?? selectedIntent;
      if (intent === undefined) {
        throw new ApiError(
          409,
          "referenced fill intent is unavailable",
          "federation_dependency",
        );
      }
      const expected = computeReleaseCommitment(
        orderDigestValue,
        intent.auth.nonce,
        releaseSecret,
      );
      if (expected !== intent.intent.releaseCommitment) {
        throw new ApiError(403, "release secret does not match the fill intent");
      }
      if (
        (storedIntent?.releaseSecret === releaseSecret && storedIntent.releasedAt !== undefined) ||
        (selectedIntent !== undefined &&
          order.releaseSecret === releaseSecret &&
          order.releasedAt !== undefined)
      ) {
        return this.pub(order);
      }
      if (storedIntent !== undefined) {
        storedIntent.releaseSecret = releaseSecret;
        storedIntent.releasedAt = now;
      }
      if (selectedIntent !== undefined && order.fill !== undefined) {
        order.releaseSecret = releaseSecret;
        order.releasedAt = now;
      }
      order.updatedAt = now;
      event = {
        kind: "release-v1",
        payload: { orderId: order.id, intentDigest: digest, releaseSecret },
      };
    }
    this.persist();
    if (order.visibility === "public") this.publish(event);
    return this.pub(order);
  }

  cancel(id: string, body: Record<string, unknown>): PublicOrder {
    this.sweep();
    const order = this.orders.get(id);
    if (!order) throw new ApiError(404, "order not found");
    this.authorized(order, body);
    if (usesPortableTerminalProtocol(order)) {
      throw new ApiError(409, "signed orders require a CancelV1 proof");
    }
    if (order.status === "cancelled") return this.pub(order);
    // Cancelling only removes the listing. If funds were already locked
    // on-chain, the HTLC claim/refund paths still govern them.
    order.status = "cancelled";
    order.updatedAt = nowS();
    this.persist();
    return this.pub(order);
  }
}
