// Taker-side parsing and verification of untrusted order book rows. The
// book is coordination only: every economic field a taker acts on is
// reconstructed here from the row and re-authenticated against the
// maker's ML-DSA-87 proofs, exactly as the browser taker does in
// frontend/src/lib/orderSigning.ts. No IO, so every gate is unit-testable.

import { isAssetSymbol, type AssetSymbol } from "./assets.js";
import type { Direction, SelectedFillIntentV1 } from "./policy.js";
import {
  EMPTY_CAPABILITY_COMMITMENT,
  EMPTY_HASHLOCK,
  PROTOCOL_V2_LIMITS,
  buildCancelV1Payload,
  buildFillIntentV1Payload,
  buildFillV1Payload,
  buildOrderV1Payload,
  computeFillDigest,
  computeFillIntentDigest,
  computeOrderDigest,
  deriveOrderV1Id,
  verifyOfficialV1Proof,
  type CancelV1Body,
  type CanonicalOrderV1Body,
  type FillIntentV1Body,
  type FillV1Body,
  type MakerOrderAuthV1,
  type ProtocolAuthV1,
  type SignedFillIntentV1,
  type SignedFillV1,
  type SignedOrderV1,
} from "./protocol-signing.js";

const BYTES32_RE = /^0x[0-9a-f]{64}$/;
const ETH_ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const QRL_ADDRESS_RE = /^Q[0-9a-f]{128}$/;
const AMOUNT_RE = /^(?:0|[1-9][0-9]{0,29})$/;
const HEX_RE = /^0x[0-9a-f]+$/;
const DESCRIPTOR_RE = /^0x[0-9a-f]{6}$/;
const ORDER_ID_RE = /^[0-9a-f]{64}$/;
const MAX_CONFLICT_DIGESTS = 32;

export type BookOrderStatus = "open" | "accepted" | "locking" | "cancelled";

/** A parsed book row. Shapes are canonical; nothing is authenticated yet. */
export interface BookOrderRow {
  id: string;
  direction: Direction;
  asset: AssetSymbol;
  fromAmount: string;
  toAmount: string;
  makerEthAccount: string;
  makerQrlAccount: string;
  status: BookOrderStatus;
  takerEthAccount: string | null;
  takerQrlAccount: string | null;
  hashlock: string | null;
  initiatorTimeout: number | null;
  responderTimeout: number | null;
  released: boolean;
  makerSeen: boolean | null;
  visibility: "public" | "private";
  allowedTakerEth?: string;
  allowedTakerQrl?: string;
  prelocked: boolean;
  makerAuth?: MakerOrderAuthV1;
  orderDigest?: string;
  fill?: FillV1Body;
  fillAuth?: ProtocolAuthV1;
  fillDigest?: string;
  selectedIntent?: SelectedFillIntentV1;
  cancelProof?: CancelV1Body;
  cancelAuth?: ProtocolAuthV1;
  cancelDigest?: string;
  equivocated: boolean;
  conflictDigests: string[];
  createdAt: number;
  updatedAt: number;
}

/** An order row whose maker proof, id and digest all authenticated. */
export interface VerifiedTakerOrder {
  id: string;
  signed: SignedOrderV1;
  orderDigest: string;
  asset: AssetSymbol;
  direction: Direction;
  /** Base units the maker escrows; what the taker receives. */
  fromAmount: bigint;
  /** Base units the taker escrows; what the taker pays. */
  toAmount: bigint;
  prelocked: boolean;
  makerSeen: boolean | null;
  expiresAt: number;
  issuedAt: number;
  row: BookOrderRow;
}

function object(raw: unknown, field: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${field} is malformed`);
  }
  return raw as Record<string, unknown>;
}

function onlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  field: string,
): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) {
    throw new Error(`${field} has unsupported fields`);
  }
}

function exactly(
  value: Record<string, unknown>,
  keys: readonly string[],
  field: string,
): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
    throw new Error(`${field} has unsupported or missing fields`);
  }
}

function text(value: unknown, pattern: RegExp, field: string): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`${field} is malformed`);
  }
  return value;
}

function uint(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} is malformed`);
  }
  return value;
}

function nullableText(
  value: unknown,
  pattern: RegExp,
  field: string,
): string | null {
  return value === null ? null : text(value, pattern, field);
}

function nullableUint(value: unknown, field: string): number | null {
  return value === null ? null : uint(value, field);
}

function boolOr(value: unknown, fallback: boolean, field: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${field} is malformed`);
  return value;
}

const PROTOCOL_AUTH_KEYS = [
  "version",
  "scheme",
  "issuedAt",
  "expiresAt",
  "nonce",
  "signature",
  "publicKey",
  "descriptor",
] as const;

export function parseProtocolAuth(raw: unknown, field: string): ProtocolAuthV1 {
  const auth = object(raw, field);
  exactly(auth, PROTOCOL_AUTH_KEYS, field);
  if (auth["version"] !== "2") throw new Error(`${field}.version is malformed`);
  if (auth["scheme"] !== "qrl-sign-message-v2") {
    throw new Error(`${field}.scheme is malformed`);
  }
  return {
    version: "2",
    scheme: "qrl-sign-message-v2",
    issuedAt: uint(auth["issuedAt"], `${field}.issuedAt`),
    expiresAt: uint(auth["expiresAt"], `${field}.expiresAt`),
    nonce: text(auth["nonce"], BYTES32_RE, `${field}.nonce`),
    signature: text(auth["signature"], HEX_RE, `${field}.signature`),
    publicKey: text(auth["publicKey"], HEX_RE, `${field}.publicKey`),
    descriptor: text(auth["descriptor"], DESCRIPTOR_RE, `${field}.descriptor`),
  };
}

export function parseMakerOrderAuth(
  raw: unknown,
  field: string,
): MakerOrderAuthV1 {
  const auth = object(raw, field);
  exactly(
    auth,
    [...PROTOCOL_AUTH_KEYS, "makerTokenCommitment", "shareTokenCommitment"],
    field,
  );
  const { makerTokenCommitment, shareTokenCommitment, ...rest } = auth;
  return {
    ...parseProtocolAuth(rest, field),
    makerTokenCommitment: text(
      makerTokenCommitment,
      BYTES32_RE,
      `${field}.makerTokenCommitment`,
    ),
    shareTokenCommitment: text(
      shareTokenCommitment,
      BYTES32_RE,
      `${field}.shareTokenCommitment`,
    ),
  };
}

export function parseFillIntentBody(
  raw: unknown,
  field: string,
): FillIntentV1Body {
  const body = object(raw, field);
  exactly(
    body,
    ["orderDigest", "takerEthAccount", "takerQrlAccount", "releaseCommitment"],
    field,
  );
  return {
    orderDigest: text(body["orderDigest"], BYTES32_RE, `${field}.orderDigest`),
    takerEthAccount: text(
      body["takerEthAccount"],
      ETH_ADDRESS_RE,
      `${field}.takerEthAccount`,
    ),
    takerQrlAccount: text(
      body["takerQrlAccount"],
      QRL_ADDRESS_RE,
      `${field}.takerQrlAccount`,
    ),
    releaseCommitment: text(
      body["releaseCommitment"],
      BYTES32_RE,
      `${field}.releaseCommitment`,
    ),
  };
}

export function parseSelectedIntent(
  raw: unknown,
  field: string,
): SelectedFillIntentV1 {
  const row = object(raw, field);
  exactly(row, ["intentDigest", "intent", "auth", "receivedAt"], field);
  const auth = parseProtocolAuth(row["auth"], `${field}.auth`);
  if (
    auth.expiresAt <= auth.issuedAt ||
    auth.expiresAt - auth.issuedAt > PROTOCOL_V2_LIMITS.fillIntentLifetimeS
  ) {
    throw new Error(`${field}.auth lifetime is malformed`);
  }
  return {
    intentDigest: text(
      row["intentDigest"],
      BYTES32_RE,
      `${field}.intentDigest`,
    ),
    intent: parseFillIntentBody(row["intent"], `${field}.intent`),
    auth,
    receivedAt: uint(row["receivedAt"], `${field}.receivedAt`),
  };
}

export function parseFillBody(raw: unknown, field: string): FillV1Body {
  const body = object(raw, field);
  exactly(
    body,
    [
      "orderDigest",
      "intentDigest",
      "takerEthAccount",
      "takerQrlAccount",
      "releaseCommitment",
      "hashlock",
      "initiatorTimeout",
      "responderTimeout",
    ],
    field,
  );
  return {
    orderDigest: text(body["orderDigest"], BYTES32_RE, `${field}.orderDigest`),
    intentDigest: text(
      body["intentDigest"],
      BYTES32_RE,
      `${field}.intentDigest`,
    ),
    takerEthAccount: text(
      body["takerEthAccount"],
      ETH_ADDRESS_RE,
      `${field}.takerEthAccount`,
    ),
    takerQrlAccount: text(
      body["takerQrlAccount"],
      QRL_ADDRESS_RE,
      `${field}.takerQrlAccount`,
    ),
    releaseCommitment: text(
      body["releaseCommitment"],
      BYTES32_RE,
      `${field}.releaseCommitment`,
    ),
    hashlock: text(body["hashlock"], BYTES32_RE, `${field}.hashlock`),
    initiatorTimeout: uint(
      body["initiatorTimeout"],
      `${field}.initiatorTimeout`,
    ),
    responderTimeout: uint(
      body["responderTimeout"],
      `${field}.responderTimeout`,
    ),
  };
}

export function parseCancelBody(raw: unknown, field: string): CancelV1Body {
  const body = object(raw, field);
  exactly(body, ["orderDigest", "reasonCode"], field);
  const reasonCode = uint(body["reasonCode"], `${field}.reasonCode`);
  if (reasonCode > 255) throw new Error(`${field}.reasonCode is malformed`);
  return {
    orderDigest: text(body["orderDigest"], BYTES32_RE, `${field}.orderDigest`),
    reasonCode,
  };
}

const ROW_KEYS = [
  "id",
  "direction",
  "asset",
  "fromAmount",
  "toAmount",
  "makerEthAccount",
  "makerQrlAccount",
  "status",
  "takerEthAccount",
  "takerQrlAccount",
  "hashlock",
  "initiatorTimeout",
  "responderTimeout",
  "released",
  "makerSeen",
  "visibility",
  "allowedTakerEth",
  "allowedTakerQrl",
  "prelocked",
  "makerAuth",
  "orderDigest",
  "fill",
  "fillAuth",
  "fillDigest",
  "selectedIntent",
  "cancelProof",
  "cancelAuth",
  "cancelDigest",
  "equivocated",
  "conflictDigests",
  "createdAt",
  "updatedAt",
] as const;

/** Parse one order row into canonical shapes. Unknown fields are refused
 *  so a book cannot smuggle terms past the checks below. */
export function parseBookOrderRow(
  raw: unknown,
  field = "order response",
): BookOrderRow {
  const row = object(raw, field);
  onlyKeys(row, ROW_KEYS, field);
  const direction = row["direction"];
  if (direction !== "eth->qrl" && direction !== "qrl->eth") {
    throw new Error(`${field}.direction is malformed`);
  }
  // A row predating stable pairs carries no symbol and means native ETH.
  const assetRaw = row["asset"] === undefined ? "ETH" : row["asset"];
  if (typeof assetRaw !== "string" || !isAssetSymbol(assetRaw)) {
    throw new Error(`${field}.asset is malformed`);
  }
  const status = row["status"];
  if (
    status !== "open" &&
    status !== "accepted" &&
    status !== "locking" &&
    status !== "cancelled"
  ) {
    throw new Error(`${field}.status is malformed`);
  }
  const visibility = row["visibility"] === undefined ? "public" : row["visibility"];
  if (visibility !== "public" && visibility !== "private") {
    throw new Error(`${field}.visibility is malformed`);
  }
  const conflictRaw = row["conflictDigests"];
  if (conflictRaw !== undefined && !Array.isArray(conflictRaw)) {
    throw new Error(`${field}.conflictDigests is malformed`);
  }
  const conflictDigests = (conflictRaw ?? []).map((value, index) =>
    text(value, BYTES32_RE, `${field}.conflictDigests[${index}]`),
  );
  if (conflictDigests.length > MAX_CONFLICT_DIGESTS) {
    throw new Error(`${field}.conflictDigests is oversized`);
  }
  return {
    id: text(row["id"], ORDER_ID_RE, `${field}.id`),
    direction,
    asset: assetRaw,
    fromAmount: text(row["fromAmount"], AMOUNT_RE, `${field}.fromAmount`),
    toAmount: text(row["toAmount"], AMOUNT_RE, `${field}.toAmount`),
    makerEthAccount: text(
      row["makerEthAccount"],
      ETH_ADDRESS_RE,
      `${field}.makerEthAccount`,
    ),
    makerQrlAccount: text(
      row["makerQrlAccount"],
      QRL_ADDRESS_RE,
      `${field}.makerQrlAccount`,
    ),
    status,
    takerEthAccount: nullableText(
      row["takerEthAccount"],
      ETH_ADDRESS_RE,
      `${field}.takerEthAccount`,
    ),
    takerQrlAccount: nullableText(
      row["takerQrlAccount"],
      QRL_ADDRESS_RE,
      `${field}.takerQrlAccount`,
    ),
    hashlock: nullableText(row["hashlock"], BYTES32_RE, `${field}.hashlock`),
    initiatorTimeout: nullableUint(
      row["initiatorTimeout"],
      `${field}.initiatorTimeout`,
    ),
    responderTimeout: nullableUint(
      row["responderTimeout"],
      `${field}.responderTimeout`,
    ),
    released: boolOr(row["released"], false, `${field}.released`),
    makerSeen:
      row["makerSeen"] === undefined
        ? null
        : boolOr(row["makerSeen"], false, `${field}.makerSeen`),
    visibility,
    ...(row["allowedTakerEth"] === undefined
      ? {}
      : {
          allowedTakerEth: text(
            row["allowedTakerEth"],
            ETH_ADDRESS_RE,
            `${field}.allowedTakerEth`,
          ),
        }),
    ...(row["allowedTakerQrl"] === undefined
      ? {}
      : {
          allowedTakerQrl: text(
            row["allowedTakerQrl"],
            QRL_ADDRESS_RE,
            `${field}.allowedTakerQrl`,
          ),
        }),
    prelocked: boolOr(row["prelocked"], false, `${field}.prelocked`),
    ...(row["makerAuth"] === undefined
      ? {}
      : { makerAuth: parseMakerOrderAuth(row["makerAuth"], `${field}.makerAuth`) }),
    ...(row["orderDigest"] === undefined
      ? {}
      : {
          orderDigest: text(
            row["orderDigest"],
            BYTES32_RE,
            `${field}.orderDigest`,
          ),
        }),
    ...(row["fill"] === undefined
      ? {}
      : { fill: parseFillBody(row["fill"], `${field}.fill`) }),
    ...(row["fillAuth"] === undefined
      ? {}
      : { fillAuth: parseProtocolAuth(row["fillAuth"], `${field}.fillAuth`) }),
    ...(row["fillDigest"] === undefined
      ? {}
      : {
          fillDigest: text(
            row["fillDigest"],
            BYTES32_RE,
            `${field}.fillDigest`,
          ),
        }),
    ...(row["selectedIntent"] === undefined
      ? {}
      : {
          selectedIntent: parseSelectedIntent(
            row["selectedIntent"],
            `${field}.selectedIntent`,
          ),
        }),
    ...(row["cancelProof"] === undefined
      ? {}
      : { cancelProof: parseCancelBody(row["cancelProof"], `${field}.cancelProof`) }),
    ...(row["cancelAuth"] === undefined
      ? {}
      : {
          cancelAuth: parseProtocolAuth(
            row["cancelAuth"],
            `${field}.cancelAuth`,
          ),
        }),
    ...(row["cancelDigest"] === undefined
      ? {}
      : {
          cancelDigest: text(
            row["cancelDigest"],
            BYTES32_RE,
            `${field}.cancelDigest`,
          ),
        }),
    equivocated: boolOr(row["equivocated"], false, `${field}.equivocated`),
    conflictDigests,
    createdAt: uint(row["createdAt"], `${field}.createdAt`),
    updatedAt: uint(row["updatedAt"], `${field}.updatedAt`),
  };
}

/** Rebuild the signed economic body from a row. Reconstruction keeps the
 *  book out of the signing payload: a changed field fails the proof. */
export function orderBodyFromRow(row: BookOrderRow): CanonicalOrderV1Body {
  return {
    direction: row.direction,
    asset: row.asset,
    fromAmount: row.fromAmount,
    toAmount: row.toAmount,
    makerEthAccount: row.makerEthAccount,
    makerQrlAccount: row.makerQrlAccount,
    visibility: row.visibility,
    ...(row.allowedTakerEth === undefined
      ? {}
      : { allowedTakerEth: row.allowedTakerEth }),
    ...(row.allowedTakerQrl === undefined
      ? {}
      : { allowedTakerQrl: row.allowedTakerQrl }),
    ...(row.prelocked && row.hashlock !== null && row.initiatorTimeout !== null
      ? { prelock: { hashlock: row.hashlock, initiatorTimeout: row.initiatorTimeout } }
      : {}),
  };
}

export interface VerifyOrderOptions {
  now?: number;
  /** Keep a proof past its expiry; used while settling a live fill. */
  allowExpired?: boolean;
}

/**
 * Authenticate a portable maker order. Returns null for anything a taker
 * must not act on: a legacy unsigned row, an expired or malformed proof,
 * a private row, or a row whose id or digest does not follow from the
 * signed fields.
 */
export function verifyMakerOrder(
  row: BookOrderRow,
  options: VerifyOrderOptions = {},
): VerifiedTakerOrder | null {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const allowExpired = options.allowExpired ?? false;
  const auth = row.makerAuth;
  if (auth === undefined) return null;
  try {
    if (
      auth.expiresAt <= auth.issuedAt ||
      auth.expiresAt - auth.issuedAt > PROTOCOL_V2_LIMITS.orderLifetimeS ||
      auth.issuedAt > now + PROTOCOL_V2_LIMITS.maxClockSkewS ||
      (!allowExpired && auth.expiresAt <= now) ||
      auth.makerTokenCommitment === EMPTY_CAPABILITY_COMMITMENT
    ) {
      return null;
    }
    // The headless taker only fills public liquidity: a private row needs
    // a share capability this client deliberately never handles.
    if (
      row.visibility !== "public" ||
      auth.shareTokenCommitment !== EMPTY_CAPABILITY_COMMITMENT ||
      row.allowedTakerEth !== undefined ||
      row.allowedTakerQrl !== undefined
    ) {
      return null;
    }
    if (row.id !== deriveOrderV1Id(row.makerQrlAccount, auth.nonce)) return null;
    if (row.prelocked && (row.hashlock === null || row.initiatorTimeout === null)) {
      return null;
    }
    const order = orderBodyFromRow(row);
    const orderDigest = computeOrderDigest(order, auth);
    if (row.orderDigest !== undefined && row.orderDigest !== orderDigest) {
      return null;
    }
    if (
      !verifyOfficialV1Proof(
        row.makerQrlAccount,
        auth,
        buildOrderV1Payload(order, auth),
      )
    ) {
      return null;
    }
    const fromAmount = BigInt(row.fromAmount);
    const toAmount = BigInt(row.toAmount);
    if (fromAmount === 0n || toAmount === 0n) return null;
    return {
      id: row.id,
      signed: { order, auth },
      orderDigest,
      asset: row.asset,
      direction: row.direction,
      fromAmount,
      toAmount,
      prelocked: row.prelocked,
      makerSeen: row.makerSeen,
      issuedAt: auth.issuedAt,
      expiresAt: auth.expiresAt,
      row,
    };
  } catch {
    return null;
  }
}

/** Re-verify a proposal this client signed. Expired proposals stay valid
 *  historical inputs once a maker has selected one, so `allowExpired`
 *  covers the settlement path. */
export function verifyOwnIntent(
  signed: SignedFillIntentV1,
  orderDigest: string,
  orderAuth: MakerOrderAuthV1,
  options: VerifyOrderOptions = {},
): boolean {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const allowExpired = options.allowExpired ?? false;
  try {
    const { intent, auth } = signed;
    if (
      intent.orderDigest !== orderDigest ||
      auth.expiresAt <= auth.issuedAt ||
      auth.expiresAt - auth.issuedAt > PROTOCOL_V2_LIMITS.fillIntentLifetimeS ||
      auth.issuedAt > now + PROTOCOL_V2_LIMITS.maxClockSkewS ||
      (!allowExpired && auth.expiresAt <= now) ||
      auth.issuedAt < orderAuth.issuedAt ||
      auth.expiresAt > orderAuth.expiresAt
    ) {
      return false;
    }
    return verifyOfficialV1Proof(
      intent.takerQrlAccount,
      auth,
      buildFillIntentV1Payload(intent, auth),
    );
  } catch {
    return false;
  }
}

export function sameSignedIntent(
  left: SignedFillIntentV1,
  right: SignedFillIntentV1,
): boolean {
  return (
    left.intent.orderDigest === right.intent.orderDigest &&
    left.intent.takerEthAccount === right.intent.takerEthAccount &&
    left.intent.takerQrlAccount === right.intent.takerQrlAccount &&
    left.intent.releaseCommitment === right.intent.releaseCommitment &&
    left.auth.version === right.auth.version &&
    left.auth.scheme === right.auth.scheme &&
    left.auth.issuedAt === right.auth.issuedAt &&
    left.auth.expiresAt === right.auth.expiresAt &&
    left.auth.nonce === right.auth.nonce &&
    left.auth.signature === right.auth.signature &&
    left.auth.publicKey === right.auth.publicKey &&
    left.auth.descriptor === right.auth.descriptor
  );
}

/** Funding is impossible for this take, and no retry will change that. */
export class FundingBlockedError extends Error {}

export interface TakerRecovery {
  orderDigest: string;
  intent: SignedFillIntentV1;
  intentDigest: string;
}

export interface VerifiedMakerFill {
  signed: SignedFillV1;
  fillDigest: string;
}

/**
 * Authenticate the maker's terminal FillV2 before the taker funds
 * anything. Returns null while the maker has published nothing yet, and
 * throws FundingBlockedError on evidence that funding must never start:
 * a release, a cancellation, equivocation, or a proof that does not bind
 * this client's own saved proposal.
 */
export function verifyMakerFill(
  row: BookOrderRow,
  recovery: TakerRecovery,
  options: VerifyOrderOptions = {},
): VerifiedMakerFill | null {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (row.released) {
    throw new FundingBlockedError(
      "this proposal was released; funding is blocked",
    );
  }
  if (
    row.equivocated ||
    row.conflictDigests.length > 0 ||
    row.cancelProof !== undefined ||
    row.cancelAuth !== undefined
  ) {
    throw new FundingBlockedError(
      "the maker published conflicting terminal messages; funding is blocked",
    );
  }
  if (row.fill === undefined && row.fillAuth === undefined) return null;
  if (
    row.status !== "locking" ||
    row.fill === undefined ||
    row.fillAuth === undefined ||
    row.selectedIntent === undefined ||
    row.makerAuth === undefined
  ) {
    throw new FundingBlockedError(
      "the order carries an incomplete FillV2; funding is blocked",
    );
  }
  const verified = verifyMakerOrder(row, { now, allowExpired: true });
  if (verified === null || verified.orderDigest !== recovery.orderDigest) {
    throw new FundingBlockedError(
      "the live order no longer matches the saved request; funding is blocked",
    );
  }
  if (now >= row.fillAuth.expiresAt) {
    throw new FundingBlockedError(
      "the maker response deadline passed before funding; request a fresh order",
    );
  }
  if (
    row.selectedIntent.intentDigest !== recovery.intentDigest ||
    !sameSignedIntent(row.selectedIntent, recovery.intent) ||
    recovery.intentDigest !==
      computeFillIntentDigest(recovery.intent.intent, recovery.intent.auth)
  ) {
    throw new FundingBlockedError(
      "the maker selected a different proposal; funding is blocked",
    );
  }
  if (
    !verifyOwnIntent(recovery.intent, recovery.orderDigest, row.makerAuth, {
      now,
      allowExpired: true,
    })
  ) {
    throw new FundingBlockedError(
      "the saved proposal no longer verifies; funding is blocked",
    );
  }
  if (!fillTermsAreValid(row, row.fill, row.fillAuth, recovery, now)) {
    throw new FundingBlockedError(
      "the maker FillV2 terms are invalid; funding is blocked",
    );
  }
  if (
    !verifyOfficialV1Proof(
      row.makerQrlAccount,
      row.fillAuth,
      buildFillV1Payload(row.fill, row.makerAuth, row.fillAuth),
    )
  ) {
    throw new FundingBlockedError(
      "the maker FillV2 proof is invalid; funding is blocked",
    );
  }
  const fillDigest = computeFillDigest(row.fill, row.makerAuth, row.fillAuth);
  if (row.fillDigest !== undefined && row.fillDigest !== fillDigest) {
    throw new FundingBlockedError(
      "the order book returned a mismatched FillV2 digest; funding is blocked",
    );
  }
  if (
    row.takerEthAccount !== row.fill.takerEthAccount ||
    row.takerQrlAccount !== row.fill.takerQrlAccount ||
    row.hashlock !== row.fill.hashlock ||
    row.initiatorTimeout !== row.fill.initiatorTimeout ||
    row.responderTimeout !== row.fill.responderTimeout
  ) {
    throw new FundingBlockedError(
      "the order projection contradicts its own FillV2; funding is blocked",
    );
  }
  return { signed: { fill: row.fill, auth: row.fillAuth }, fillDigest };
}

/** Timeout, window and binding rules a FillV2 must satisfy. Identical to
 *  the browser taker's and to what the maker signer itself enforces. */
function fillTermsAreValid(
  row: BookOrderRow,
  fill: FillV1Body,
  auth: ProtocolAuthV1,
  recovery: TakerRecovery,
  now: number,
): boolean {
  const limits = PROTOCOL_V2_LIMITS;
  const responseWindow = auth.expiresAt - auth.issuedAt;
  const initiatorWindow = fill.initiatorTimeout - auth.issuedAt;
  const responderWindow = fill.responderTimeout - auth.issuedAt;
  const orderAuth = row.makerAuth;
  if (orderAuth === undefined) return false;
  return (
    fill.hashlock !== EMPTY_HASHLOCK &&
    fill.orderDigest === recovery.orderDigest &&
    fill.intentDigest === recovery.intentDigest &&
    fill.takerEthAccount === recovery.intent.intent.takerEthAccount &&
    fill.takerQrlAccount === recovery.intent.intent.takerQrlAccount &&
    fill.releaseCommitment === recovery.intent.intent.releaseCommitment &&
    responseWindow >= limits.minFillResponseS &&
    responseWindow <= limits.maxFillResponseS &&
    auth.issuedAt <= now + limits.maxClockSkewS &&
    auth.expiresAt <= orderAuth.expiresAt &&
    auth.issuedAt >= recovery.intent.auth.issuedAt &&
    auth.issuedAt < recovery.intent.auth.expiresAt &&
    responderWindow > 0 &&
    responderWindow <= limits.maxResponderWindowS &&
    fill.responderTimeout - auth.expiresAt >
      limits.minResponderRunwayAfterResponseS &&
    initiatorWindow >= responderWindow &&
    responderWindow <= Math.floor(initiatorWindow / 2) &&
    (row.prelocked || initiatorWindow <= limits.maxInitiatorWindowS) &&
    (!row.prelocked ||
      (fill.hashlock === row.hashlock &&
        fill.initiatorTimeout === row.initiatorTimeout))
  );
}

/** Authenticate a maker cancellation, the tombstone that ends a take
 *  attempt before any funds move. */
export function verifyMakerCancel(
  row: BookOrderRow,
  orderDigest: string,
  options: VerifyOrderOptions = {},
): boolean {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const auth = row.cancelAuth;
  const cancel = row.cancelProof;
  const orderAuth = row.makerAuth;
  if (auth === undefined || cancel === undefined || orderAuth === undefined) {
    return false;
  }
  try {
    if (
      cancel.orderDigest !== orderDigest ||
      auth.issuedAt < orderAuth.issuedAt ||
      auth.issuedAt > orderAuth.expiresAt ||
      auth.expiresAt !== orderAuth.expiresAt ||
      auth.issuedAt > now + PROTOCOL_V2_LIMITS.maxClockSkewS
    ) {
      return false;
    }
    return verifyOfficialV1Proof(
      row.makerQrlAccount,
      auth,
      buildCancelV1Payload(cancel, orderAuth, auth),
    );
  } catch {
    return false;
  }
}
