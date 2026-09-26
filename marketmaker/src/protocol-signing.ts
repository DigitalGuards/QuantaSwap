import {
  ORDER_V2_DOMAIN,
  ORDER_V2_DEPLOYMENT,
  protocolMessageBytes,
  assertV2Deployment,
} from "./protocol-v2-wire.js";
// Portable ML-DSA-87 protocol proofs for a headless liquidity provider.
// The signed messages are reconstructed from canonical wire bodies. Callers
// never supply an arbitrary typed-data payload to sign.

import { createHash, randomBytes } from "node:crypto";
import {
  ML_DSA_87_PUBLIC_KEY_BYTES,
  ML_DSA_87_SIGNATURE_BYTES,
  SCHEME_TAG_MSG,
  computeMessageDigest,
  verifyMessageForSigner,
} from "@qrlwallet/connect";
import { cryptoSignSignature, CryptoBytes } from "@theqrl/mldsa87";
import { ExtendedSeed, MLDSA87 } from "@theqrl/wallet.js";
import { getBytes } from "ethers";
import { isAssetSymbol, type AssetSymbol } from "./assets.js";
import type { Direction } from "./policy.js";
import {
  assertPortableOrderV1CanSign,
  canonicalQip55QrlAddress,
} from "./qip55.js";

/** Source compatibility name; the wire domain is exclusively V2. */
export const ORDER_V1_DOMAIN = ORDER_V2_DOMAIN;

export const ORDER_V1_DEPLOYMENT = ORDER_V2_DEPLOYMENT;

export const ORDER_ID_V1_PREFIX = "QuantaSwap OrderV2 id\0";
export const RELEASE_V1_PREFIX = "QuantaSwap ReleaseV2\0";

export const ORDER_V1_FIELDS = [
  { name: "direction", type: "string" },
  { name: "asset", type: "string" },
  { name: "fromAmount", type: "uint256" },
  { name: "toAmount", type: "uint256" },
  { name: "makerEthAccount", type: "string" },
  { name: "makerQrlAccount", type: "string" },
  { name: "visibility", type: "string" },
  { name: "allowedTakerEth", type: "string" },
  { name: "allowedTakerQrl", type: "string" },
  { name: "prelocked", type: "bool" },
  { name: "hashlock", type: "bytes32" },
  { name: "initiatorTimeout", type: "uint64" },
  { name: "issuedAt", type: "uint64" },
  { name: "expiresAt", type: "uint64" },
  { name: "nonce", type: "bytes32" },
  { name: "makerTokenCommitment", type: "bytes32" },
  { name: "shareTokenCommitment", type: "bytes32" },
  { name: "ethChainId", type: "uint256" },
  { name: "ethHtlc", type: "string" },
  { name: "qrlChainId", type: "uint256" },
  { name: "qrlHtlc", type: "string" },
] as const;

export const FILL_INTENT_V1_FIELDS = [
  { name: "orderDigest", type: "bytes32" },
  { name: "requestNonce", type: "bytes32" },
  { name: "takerEthAccount", type: "string" },
  { name: "takerQrlAccount", type: "string" },
  { name: "releaseCommitment", type: "bytes32" },
  { name: "issuedAt", type: "uint64" },
  { name: "expiresAt", type: "uint64" },
  { name: "ethChainId", type: "uint256" },
  { name: "ethHtlc", type: "string" },
  { name: "qrlChainId", type: "uint256" },
  { name: "qrlHtlc", type: "string" },
] as const;

export const FILL_V1_FIELDS = [
  { name: "orderDigest", type: "bytes32" },
  { name: "orderNonce", type: "bytes32" },
  { name: "intentDigest", type: "bytes32" },
  { name: "fillNonce", type: "bytes32" },
  { name: "takerEthAccount", type: "string" },
  { name: "takerQrlAccount", type: "string" },
  { name: "releaseCommitment", type: "bytes32" },
  { name: "hashlock", type: "bytes32" },
  { name: "initiatorTimeout", type: "uint64" },
  { name: "responderTimeout", type: "uint64" },
  { name: "issuedAt", type: "uint64" },
  { name: "respondBy", type: "uint64" },
  { name: "ethChainId", type: "uint256" },
  { name: "ethHtlc", type: "string" },
  { name: "qrlChainId", type: "uint256" },
  { name: "qrlHtlc", type: "string" },
] as const;

export const CANCEL_V1_FIELDS = [
  { name: "orderDigest", type: "bytes32" },
  { name: "orderNonce", type: "bytes32" },
  { name: "cancelNonce", type: "bytes32" },
  { name: "issuedAt", type: "uint64" },
  { name: "reasonCode", type: "uint8" },
  { name: "ethChainId", type: "uint256" },
  { name: "ethHtlc", type: "string" },
  { name: "qrlChainId", type: "uint256" },
  { name: "qrlHtlc", type: "string" },
] as const;

export const EMPTY_HASHLOCK = `0x${"00".repeat(32)}`;
export const EMPTY_CAPABILITY_COMMITMENT = `0x${"00".repeat(32)}`;
export const MAKER_CAPABILITY_DOMAIN = "QuantaSwap Maker capability V2\0";
export const SHARE_CAPABILITY_DOMAIN = "QuantaSwap Share capability V2\0";
const OFFICIAL_DESCRIPTOR = "0x010000";
const ORDER_LIFETIME_S = 48 * 3600;
const MIN_ORDER_LIFETIME_S = 60;
const MIN_FILL_RESPONSE_S = 60;
const MAX_FILL_RESPONSE_S = 15 * 60;
const MAX_FILL_INTENT_LIFETIME_S = 120;
const MAX_CLOCK_SKEW_S = 5 * 60;
const MIN_PRELOCK_LISTING_WINDOW_S = 3 * 60 * 60;
const MAX_PRELOCK_LISTING_WINDOW_S = 72 * 60 * 60;
const MAX_RESPONDER_WINDOW_S = 2 * 60 * 60;
const MAX_INITIATOR_WINDOW_S = 4 * 60 * 60;
const MIN_RESPONDER_RUNWAY_AFTER_RESPONSE_S = 600;
const ETH_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const CAIP_ETH_ADDRESS_RE = /^eip155:11155111:(0x[0-9a-fA-F]{40})$/;
// Portable V2 binds the full 64-byte QRL identity.
const QRL_ADDRESS_RE = /^Q[0-9a-fA-F]{128}$/;
const AMOUNT_RE = /^(?:0|[1-9][0-9]{0,29})$/;
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;
const CANONICAL_BYTES32_RE = /^0x[0-9a-f]{64}$/;
const CANONICAL_ETH_ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const CANONICAL_QRL_ADDRESS_RE = /^Q[0-9a-f]{128}$/;
const SIGNATURE_RE = new RegExp(
  `^0x[0-9a-f]{${ML_DSA_87_SIGNATURE_BYTES * 2}}$`,
);
const PUBLIC_KEY_RE = new RegExp(
  `^0x[0-9a-f]{${ML_DSA_87_PUBLIC_KEY_BYTES * 2}}$`,
);
const DESCRIPTOR_RE = /^0x[0-9a-f]{6}$/;
const CAPABILITY_RE = /^[0-9a-f]{64}$/;

/** Protocol-wide V2 bounds, exported so a taker client applies exactly the
 *  same windows the maker signer and the browser enforce. */
export const PROTOCOL_V2_LIMITS = {
  orderLifetimeS: ORDER_LIFETIME_S,
  minOrderLifetimeS: MIN_ORDER_LIFETIME_S,
  fillIntentLifetimeS: MAX_FILL_INTENT_LIFETIME_S,
  minFillResponseS: MIN_FILL_RESPONSE_S,
  maxFillResponseS: MAX_FILL_RESPONSE_S,
  minResponderRunwayAfterResponseS: MIN_RESPONDER_RUNWAY_AFTER_RESPONSE_S,
  maxResponderWindowS: MAX_RESPONDER_WINDOW_S,
  maxInitiatorWindowS: MAX_INITIATOR_WINDOW_S,
  maxClockSkewS: MAX_CLOCK_SKEW_S,
  minPrelockListingWindowS: MIN_PRELOCK_LISTING_WINDOW_S,
  maxPrelockListingWindowS: MAX_PRELOCK_LISTING_WINDOW_S,
} as const;

export type OrderSigningScheme = "qrl-sign-message-v2";

type TypedDataField = { readonly name: string; readonly type: string };

export interface ProtocolTypedDataPayload {
  types: Record<string, readonly TypedDataField[]>;
  primaryType: "OrderV2" | "FillIntentV2" | "FillV2" | "CancelV2";
  domain: typeof ORDER_V1_DOMAIN;
  message: Record<string, unknown>;
}

export interface OrderV1Body {
  direction: Direction;
  asset: AssetSymbol;
  fromAmount: string;
  toAmount: string;
  makerEthAccount: string;
  makerQrlAccount: string;
  visibility?: "public" | "private";
  allowedTakerEth?: string;
  allowedTakerQrl?: string;
  prelock?: {
    hashlock: string;
    initiatorTimeout: number;
  };
}

export interface CanonicalOrderV1Body extends Omit<
  OrderV1Body,
  "visibility" | "prelock"
> {
  visibility: "public" | "private";
  prelock?: {
    hashlock: string;
    initiatorTimeout: number;
  };
}

export interface ProtocolAuthV1 {
  version: "2";
  scheme: OrderSigningScheme;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
  signature: string;
  publicKey: string;
  descriptor: string;
}

export interface MakerOrderAuthV1 extends ProtocolAuthV1 {
  makerTokenCommitment: string;
  shareTokenCommitment: string;
}

export interface SignedOrderV1 {
  order: CanonicalOrderV1Body;
  auth: MakerOrderAuthV1;
}

export interface FillIntentV1Body {
  orderDigest: string;
  takerEthAccount: string;
  takerQrlAccount: string;
  releaseCommitment: string;
}

export interface FillIntentV1Terms extends FillIntentV1Body {
  requestNonce: string;
  issuedAt: string;
  expiresAt: string;
  ethChainId: string;
  ethHtlc: string;
  qrlChainId: string;
  qrlHtlc: string;
}

/** A taker's own signed proposal, as submitted to the book. */
export interface SignedFillIntentV1 {
  intent: FillIntentV1Body;
  auth: ProtocolAuthV1;
}

export interface FillV1Body {
  orderDigest: string;
  intentDigest: string;
  takerEthAccount: string;
  takerQrlAccount: string;
  releaseCommitment: string;
  hashlock: string;
  initiatorTimeout: number;
  responderTimeout: number;
}

export interface SignedFillV1 {
  fill: FillV1Body;
  auth: ProtocolAuthV1;
}

export interface CancelV1Body {
  orderDigest: string;
  reasonCode: number;
}

export interface SignedCancelV1 {
  cancel: CancelV1Body;
  auth: ProtocolAuthV1;
}

interface SignOrderV1Options {
  makerToken: string;
  shareToken?: string;
  issuedAt?: number;
  expiresAt?: number;
  nonce?: string;
}

interface SignFillV1Options {
  order: SignedOrderV1;
  selectedIntent: {
    intentDigest: string;
    intent: FillIntentV1Body;
    auth: ProtocolAuthV1;
  };
  respondBy: number;
  issuedAt?: number;
  fillNonce?: string;
}

interface SignFillIntentV1Options {
  /** The maker order this proposal targets, exactly as authenticated. */
  order: SignedOrderV1;
  /** Digest the caller already verified; a mismatch refuses to sign. */
  orderDigest: string;
  takerEthAccount: string;
  /** 32-byte walk-away secret; only its commitment is published. */
  releaseSecret: string;
  issuedAt?: number;
  expiresAt?: number;
  requestNonce?: string;
}

interface SignCancelV1Options {
  orderNonce: string;
  expiresAt: number;
  issuedAt?: number;
  cancelNonce?: string;
}

type WalletWithCleanup = ReturnType<
  typeof MLDSA87.newWalletFromExtendedSeed
> & {
  zeroize(): void;
};

function hex(bytes: Uint8Array): string {
  return `0x${Buffer.from(bytes).toString("hex")}`;
}

function nonceHex(): string {
  return hex(randomBytes(32));
}

function capabilityToken(value: string, field: string): string {
  if (!CAPABILITY_RE.test(value))
    throw new Error(`${field} must be 32 raw bytes as lowercase hex`);
  return value;
}

export function capabilityCommitment(domain: string, token: string): string {
  const canonical = capabilityToken(token, "capability token");
  return `0x${createHash("sha256")
    .update(Buffer.from(domain, "utf8"))
    .update(Buffer.from(canonical, "hex"))
    .digest("hex")}`;
}

function bytes32(value: string, field: string): string {
  if (!BYTES32_RE.test(value))
    throw new Error(`${field} must be a 32-byte hex string`);
  return value.toLowerCase();
}

function safeUint(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function uint8(value: number, field: string): number {
  safeUint(value, field);
  if (value > 255) throw new Error(`${field} must fit uint8`);
  return value;
}

function ethAddress(value: string, field: string): string {
  if (!ETH_ADDRESS_RE.test(value))
    throw new Error(`${field} must be an Ethereum address`);
  return value.toLowerCase();
}

function caipEthAddress(value: string, field: string): string {
  const caip = CAIP_ETH_ADDRESS_RE.exec(value);
  const address = caip?.[1] ?? value;
  return `eip155:${ORDER_V1_DEPLOYMENT.ethChainId}:${ethAddress(address, field)}`;
}

function qrlAddress(value: string, field: string): string {
  if (!QRL_ADDRESS_RE.test(value))
    throw new Error(`${field} must be a QRL address`);
  canonicalQip55QrlAddress(value);
  return `Q${value.slice(1).toLowerCase()}`;
}

function amount(value: string, field: string): string {
  if (!AMOUNT_RE.test(value))
    throw new Error(`${field} must be a canonical base-unit amount`);
  return value;
}

function payload(
  primaryType: ProtocolTypedDataPayload["primaryType"],
  fields: readonly TypedDataField[],
  message: Record<string, unknown>,
  scheme: OrderSigningScheme = "qrl-sign-message-v2",
): ProtocolTypedDataPayload {
  if (scheme !== "qrl-sign-message-v2")
    throw new Error("Unsupported portable V2 scheme");
  return {
    types: { [primaryType]: [...fields] },
    primaryType,
    domain: { ...ORDER_V2_DOMAIN },
    message,
  };
}

function normalizeOrderBody(body: OrderV1Body): CanonicalOrderV1Body {
  if (body.direction !== "eth->qrl" && body.direction !== "qrl->eth") {
    throw new Error("order.direction is invalid");
  }
  if (!isAssetSymbol(body.asset)) throw new Error("order.asset is invalid");
  const visibility = body.visibility ?? "public";
  if (visibility !== "public" && visibility !== "private") {
    throw new Error("order.visibility is invalid");
  }
  if (
    visibility === "public" &&
    (body.allowedTakerEth !== undefined || body.allowedTakerQrl !== undefined)
  ) {
    throw new Error("public orders cannot restrict the taker");
  }
  const allowedTakerEth = body.allowedTakerEth;
  const allowedTakerQrl = body.allowedTakerQrl;
  return {
    direction: body.direction,
    asset: body.asset,
    fromAmount: amount(body.fromAmount, "order.fromAmount"),
    toAmount: amount(body.toAmount, "order.toAmount"),
    makerEthAccount: ethAddress(body.makerEthAccount, "order.makerEthAccount"),
    makerQrlAccount: qrlAddress(body.makerQrlAccount, "order.makerQrlAccount"),
    visibility,
    ...(allowedTakerEth === undefined
      ? {}
      : {
          allowedTakerEth: ethAddress(allowedTakerEth, "order.allowedTakerEth"),
        }),
    ...(allowedTakerQrl === undefined
      ? {}
      : {
          allowedTakerQrl: qrlAddress(allowedTakerQrl, "order.allowedTakerQrl"),
        }),
    ...(body.prelock === undefined
      ? {}
      : {
          prelock: {
            hashlock: bytes32(body.prelock.hashlock, "order.prelock.hashlock"),
            initiatorTimeout: safeUint(
              body.prelock.initiatorTimeout,
              "order.prelock.initiatorTimeout",
            ),
          },
        }),
  };
}

function orderMessage(
  order: CanonicalOrderV1Body,
  auth: Pick<
    MakerOrderAuthV1,
    | "issuedAt"
    | "expiresAt"
    | "nonce"
    | "makerTokenCommitment"
    | "shareTokenCommitment"
  >,
): Record<string, unknown> {
  return {
    direction: order.direction,
    asset: order.asset,
    fromAmount: order.fromAmount,
    toAmount: order.toAmount,
    makerEthAccount: caipEthAddress(
      order.makerEthAccount,
      "order.makerEthAccount",
    ),
    makerQrlAccount: order.makerQrlAccount,
    visibility: order.visibility,
    allowedTakerEth:
      order.allowedTakerEth === undefined
        ? ""
        : caipEthAddress(order.allowedTakerEth, "order.allowedTakerEth"),
    allowedTakerQrl: order.allowedTakerQrl ?? "",
    prelocked: order.prelock !== undefined,
    hashlock: order.prelock?.hashlock ?? EMPTY_HASHLOCK,
    initiatorTimeout: String(order.prelock?.initiatorTimeout ?? 0),
    issuedAt: String(safeUint(auth.issuedAt, "auth.issuedAt")),
    expiresAt: String(safeUint(auth.expiresAt, "auth.expiresAt")),
    nonce: bytes32(auth.nonce, "auth.nonce"),
    makerTokenCommitment: bytes32(
      auth.makerTokenCommitment,
      "auth.makerTokenCommitment",
    ),
    shareTokenCommitment: bytes32(
      auth.shareTokenCommitment,
      "auth.shareTokenCommitment",
    ),
    ...ORDER_V1_DEPLOYMENT,
  };
}

export function buildOrderV1Payload(
  body: OrderV1Body,
  auth: Pick<
    MakerOrderAuthV1,
    | "issuedAt"
    | "expiresAt"
    | "nonce"
    | "makerTokenCommitment"
    | "shareTokenCommitment"
  >,
): ProtocolTypedDataPayload {
  const order = normalizeOrderBody(body);
  return payload("OrderV2", ORDER_V1_FIELDS, orderMessage(order, auth));
}

export function buildFillIntentV1Payload(
  body: FillIntentV1Body,
  auth: Pick<ProtocolAuthV1, "issuedAt" | "expiresAt" | "nonce">,
  scheme: OrderSigningScheme = "qrl-sign-message-v2",
): ProtocolTypedDataPayload {
  const issuedAt = safeUint(auth.issuedAt, "intent.issuedAt");
  const expiresAt = safeUint(auth.expiresAt, "intent.expiresAt");
  if (expiresAt <= issuedAt)
    throw new Error("intent expiry must follow issuance");
  return payload(
    "FillIntentV2",
    FILL_INTENT_V1_FIELDS,
    {
      orderDigest: bytes32(body.orderDigest, "intent.orderDigest"),
      requestNonce: bytes32(auth.nonce, "intent.requestNonce"),
      takerEthAccount: caipEthAddress(
        body.takerEthAccount,
        "intent.takerEthAccount",
      ),
      takerQrlAccount: qrlAddress(
        body.takerQrlAccount,
        "intent.takerQrlAccount",
      ),
      releaseCommitment: bytes32(
        body.releaseCommitment,
        "intent.releaseCommitment",
      ),
      issuedAt: String(issuedAt),
      expiresAt: String(expiresAt),
      ...ORDER_V1_DEPLOYMENT,
    },
    scheme,
  );
}

function normalizeFillBody(body: FillV1Body): FillV1Body {
  return {
    orderDigest: bytes32(body.orderDigest, "fill.orderDigest"),
    intentDigest: bytes32(body.intentDigest, "fill.intentDigest"),
    takerEthAccount: ethAddress(body.takerEthAccount, "fill.takerEthAccount"),
    takerQrlAccount: qrlAddress(body.takerQrlAccount, "fill.takerQrlAccount"),
    releaseCommitment: bytes32(
      body.releaseCommitment,
      "fill.releaseCommitment",
    ),
    hashlock: bytes32(body.hashlock, "fill.hashlock"),
    initiatorTimeout: safeUint(body.initiatorTimeout, "fill.initiatorTimeout"),
    responderTimeout: safeUint(body.responderTimeout, "fill.responderTimeout"),
  };
}

export function buildFillV1Payload(
  body: FillV1Body,
  orderAuth: Pick<MakerOrderAuthV1, "nonce">,
  auth: Pick<ProtocolAuthV1, "issuedAt" | "expiresAt" | "nonce">,
): ProtocolTypedDataPayload {
  const fill = normalizeFillBody(body);
  const issuedAt = safeUint(auth.issuedAt, "auth.issuedAt");
  const respondBy = safeUint(auth.expiresAt, "auth.expiresAt");
  if (respondBy <= issuedAt)
    throw new Error("fill response deadline must follow issuance");
  return payload("FillV2", FILL_V1_FIELDS, {
    orderDigest: fill.orderDigest,
    intentDigest: fill.intentDigest,
    takerEthAccount: caipEthAddress(
      fill.takerEthAccount,
      "fill.takerEthAccount",
    ),
    takerQrlAccount: fill.takerQrlAccount,
    releaseCommitment: fill.releaseCommitment,
    hashlock: fill.hashlock,
    initiatorTimeout: String(fill.initiatorTimeout),
    responderTimeout: String(fill.responderTimeout),
    orderNonce: bytes32(orderAuth.nonce, "orderAuth.nonce"),
    fillNonce: bytes32(auth.nonce, "auth.nonce"),
    issuedAt: String(issuedAt),
    respondBy: String(respondBy),
    ...ORDER_V1_DEPLOYMENT,
  });
}

function normalizeCancelBody(body: CancelV1Body): CancelV1Body {
  return {
    orderDigest: bytes32(body.orderDigest, "cancel.orderDigest"),
    reasonCode: uint8(body.reasonCode, "cancel.reasonCode"),
  };
}

export function buildCancelV1Payload(
  body: CancelV1Body,
  orderAuth: Pick<MakerOrderAuthV1, "nonce">,
  auth: Pick<ProtocolAuthV1, "issuedAt" | "nonce">,
): ProtocolTypedDataPayload {
  const cancel = normalizeCancelBody(body);
  return payload("CancelV2", CANCEL_V1_FIELDS, {
    ...cancel,
    orderNonce: bytes32(orderAuth.nonce, "orderAuth.nonce"),
    cancelNonce: bytes32(auth.nonce, "auth.nonce"),
    issuedAt: String(safeUint(auth.issuedAt, "auth.issuedAt")),
    ...ORDER_V1_DEPLOYMENT,
  });
}

/** A scheme-neutral content digest used to link signed protocol artifacts. */
export function semanticDigest(payloadValue: ProtocolTypedDataPayload): string {
  return hex(
    createHash("sha256").update(protocolMessageBytes(payloadValue)).digest(),
  );
}

export function computeOrderDigest(
  body: OrderV1Body,
  auth: Pick<
    MakerOrderAuthV1,
    | "issuedAt"
    | "expiresAt"
    | "nonce"
    | "makerTokenCommitment"
    | "shareTokenCommitment"
  >,
): string {
  return semanticDigest(buildOrderV1Payload(body, auth));
}

export function deriveOrderV1Id(
  makerQrlAccount: string,
  nonce: string,
): string {
  const maker = qrlAddress(makerQrlAccount, "makerQrlAccount");
  const canonicalNonce = bytes32(nonce, "nonce");
  return createHash("sha256")
    .update(Buffer.from(ORDER_ID_V1_PREFIX, "utf8"))
    .update(Buffer.from(maker.slice(1), "hex"))
    .update(Buffer.from(canonicalNonce.slice(2), "hex"))
    .digest("hex");
}

export function computeReleaseCommitment(
  orderDigest: string,
  requestNonce: string,
  releaseSecret: string,
): string {
  return `0x${createHash("sha256")
    .update(Buffer.from(RELEASE_V1_PREFIX, "utf8"))
    .update(Buffer.from(bytes32(orderDigest, "orderDigest").slice(2), "hex"))
    .update(Buffer.from(bytes32(requestNonce, "requestNonce").slice(2), "hex"))
    .update(
      Buffer.from(bytes32(releaseSecret, "releaseSecret").slice(2), "hex"),
    )
    .digest("hex")}`;
}

export function computeFillIntentDigest(
  body: FillIntentV1Body,
  auth: Pick<ProtocolAuthV1, "issuedAt" | "expiresAt" | "nonce">,
): string {
  return semanticDigest(buildFillIntentV1Payload(body, auth));
}

export function computeFillDigest(
  body: FillV1Body,
  orderAuth: Pick<MakerOrderAuthV1, "nonce">,
  auth: Pick<ProtocolAuthV1, "issuedAt" | "expiresAt" | "nonce">,
): string {
  return semanticDigest(buildFillV1Payload(body, orderAuth, auth));
}

export function computeCancelDigest(
  body: CancelV1Body,
  orderAuth: Pick<MakerOrderAuthV1, "nonce">,
  auth: Pick<ProtocolAuthV1, "issuedAt" | "nonce">,
): string {
  return semanticDigest(buildCancelV1Payload(body, orderAuth, auth));
}

/** Source compatibility helper: returns the V2 message digest. */
export function officialQrlDigest(
  payloadValue: ProtocolTypedDataPayload,
): Uint8Array {
  return computeMessageDigest(protocolMessageBytes(payloadValue));
}

export interface VerifyFillIntentV1Options {
  now?: number;
  orderIssuedAt?: number;
  orderExpiresAt?: number;
}

function hasExactKeys(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const actual = Object.keys(value);
  return (
    actual.length === keys.length && keys.every((key) => actual.includes(key))
  );
}

function fillIntentBodyIsCanonical(value: unknown): value is FillIntentV1Body {
  if (
    !hasExactKeys(value, [
      "orderDigest",
      "takerEthAccount",
      "takerQrlAccount",
      "releaseCommitment",
    ])
  ) {
    return false;
  }
  return (
    typeof value["orderDigest"] === "string" &&
    CANONICAL_BYTES32_RE.test(value["orderDigest"]) &&
    typeof value["takerEthAccount"] === "string" &&
    CANONICAL_ETH_ADDRESS_RE.test(value["takerEthAccount"]) &&
    typeof value["takerQrlAccount"] === "string" &&
    CANONICAL_QRL_ADDRESS_RE.test(value["takerQrlAccount"]) &&
    typeof value["releaseCommitment"] === "string" &&
    CANONICAL_BYTES32_RE.test(value["releaseCommitment"])
  );
}

function protocolAuthIsCanonical(
  value: unknown,
  now: number,
): value is ProtocolAuthV1 {
  if (
    !hasExactKeys(value, [
      "version",
      "scheme",
      "issuedAt",
      "expiresAt",
      "nonce",
      "signature",
      "publicKey",
      "descriptor",
    ])
  ) {
    return false;
  }
  const issuedAt = value["issuedAt"];
  const expiresAt = value["expiresAt"];
  const scheme = value["scheme"];
  const descriptor = value["descriptor"];
  return (
    value["version"] === "2" &&
    scheme === "qrl-sign-message-v2" &&
    typeof issuedAt === "number" &&
    Number.isSafeInteger(issuedAt) &&
    !Object.is(issuedAt, -0) &&
    issuedAt >= 0 &&
    typeof expiresAt === "number" &&
    Number.isSafeInteger(expiresAt) &&
    !Object.is(expiresAt, -0) &&
    expiresAt > issuedAt &&
    expiresAt - issuedAt <= MAX_FILL_INTENT_LIFETIME_S &&
    issuedAt <= now + MAX_CLOCK_SKEW_S &&
    expiresAt > now &&
    typeof value["nonce"] === "string" &&
    CANONICAL_BYTES32_RE.test(value["nonce"]) &&
    typeof value["signature"] === "string" &&
    SIGNATURE_RE.test(value["signature"]) &&
    typeof value["publicKey"] === "string" &&
    PUBLIC_KEY_RE.test(value["publicKey"]) &&
    typeof descriptor === "string" &&
    DESCRIPTOR_RE.test(descriptor)
  );
}

export function deriveLegacyV1QrlAddress(
  descriptorHex: string,
  publicKeyHex: string,
): string {
  const descriptor = getBytes(descriptorHex);
  const publicKey = getBytes(publicKeyHex);
  if (descriptor.length !== 3 || descriptor[0] !== 1) {
    throw new Error("legacy V1 identity requires an ML-DSA descriptor");
  }
  if (publicKey.length !== ML_DSA_87_PUBLIC_KEY_BYTES) {
    throw new Error("legacy V1 identity requires an ML-DSA-87 public key");
  }
  return `Q${createHash("shake256", { outputLength: 20 })
    .update(descriptor)
    .update(publicKey)
    .digest("hex")}`;
}

/** Source compatibility helper: accepts only a V2 message proof. */
export function verifyOfficialV1Proof(
  signer: string,
  auth: Pick<
    ProtocolAuthV1,
    "scheme" | "signature" | "publicKey" | "descriptor"
  >,
  payloadValue: ProtocolTypedDataPayload,
): boolean {
  try {
    assertV2Deployment();
    return (
      auth.scheme === "qrl-sign-message-v2" &&
      verifyMessageForSigner({
        expectedSigner: signer,
        descriptor: auth.descriptor,
        signature: auth.signature,
        publicKey: auth.publicKey,
        messageBytes: protocolMessageBytes(payloadValue),
      })
    );
  } catch {
    return false;
  }
}

/**
 * Independently verify a taker's portable FillIntentV1 proof. The fixed
 * deployment fields are reconstructed locally, so the order book supplies no
 * trusted signing payload or signer identity.
 */
export function verifyFillIntentV1(
  body: unknown,
  auth: unknown,
  expectedOrderDigest: string,
  options: VerifyFillIntentV1Options = {},
): boolean {
  try {
    const now = options.now ?? Math.floor(Date.now() / 1000);
    if (
      !Number.isSafeInteger(now) ||
      now < 0 ||
      now > Number.MAX_SAFE_INTEGER - MAX_CLOCK_SKEW_S
    ) {
      return false;
    }
    if (
      typeof expectedOrderDigest !== "string" ||
      !CANONICAL_BYTES32_RE.test(expectedOrderDigest)
    ) {
      return false;
    }
    if (
      !fillIntentBodyIsCanonical(body) ||
      !protocolAuthIsCanonical(auth, now)
    ) {
      return false;
    }
    if (body.orderDigest !== expectedOrderDigest) return false;

    const orderIssuedAt = options.orderIssuedAt;
    if (
      orderIssuedAt !== undefined &&
      (!Number.isSafeInteger(orderIssuedAt) ||
        orderIssuedAt < 0 ||
        auth.issuedAt < orderIssuedAt)
    ) {
      return false;
    }
    const orderExpiresAt = options.orderExpiresAt;
    if (
      orderExpiresAt !== undefined &&
      (!Number.isSafeInteger(orderExpiresAt) ||
        orderExpiresAt < 0 ||
        auth.expiresAt > orderExpiresAt)
    ) {
      return false;
    }
    if (
      orderIssuedAt !== undefined &&
      orderExpiresAt !== undefined &&
      orderExpiresAt <= orderIssuedAt
    ) {
      return false;
    }
    const payloadValue = buildFillIntentV1Payload(body, auth, auth.scheme);
    return verifyOfficialV1Proof(body.takerQrlAccount, auth, payloadValue);
  } catch {
    return false;
  }
}

function walletFromExtendedSeed(input: string | Uint8Array): WalletWithCleanup {
  const extendedSeed = ExtendedSeed.from(input);
  try {
    if (hex(extendedSeed.getDescriptorBytes()) !== OFFICIAL_DESCRIPTOR) {
      throw new Error("QRL extended seed must use descriptor 0x010000");
    }
    return MLDSA87.newWalletFromExtendedSeed(extendedSeed) as WalletWithCleanup;
  } finally {
    (extendedSeed as typeof extendedSeed & { zeroize(): void }).zeroize();
  }
}

export class ProtocolSigner {
  readonly address: string;
  readonly publicKey: string;
  readonly descriptor = OFFICIAL_DESCRIPTOR;
  private readonly wallet: WalletWithCleanup;
  private closed = false;

  constructor(extendedSeed: string | Uint8Array) {
    this.wallet = walletFromExtendedSeed(extendedSeed);
    this.address = `Q${canonicalQip55QrlAddress(this.wallet.getAddressStr()).slice(1).toLowerCase()}`;
    this.publicKey = hex(this.wallet.getPK());
  }

  signOrderV1(body: OrderV1Body, options: SignOrderV1Options): SignedOrderV1 {
    this.assertOpen();
    assertPortableOrderV1CanSign(this.address);
    const order = normalizeOrderBody(body);
    if (order.visibility !== "public") {
      throw new Error(
        "headless market maker supports public signed orders only",
      );
    }
    if (order.makerQrlAccount !== this.address) {
      throw new Error(
        "order maker QRL account does not match the signing seed",
      );
    }
    const issuedAt = safeUint(
      options.issuedAt ?? Math.floor(Date.now() / 1000),
      "auth.issuedAt",
    );
    const defaultExpiry = Math.min(
      issuedAt + ORDER_LIFETIME_S,
      order.prelock?.initiatorTimeout ?? Number.POSITIVE_INFINITY,
    );
    const expiresAt = safeUint(
      options.expiresAt ?? defaultExpiry,
      "auth.expiresAt",
    );
    if (expiresAt - issuedAt < MIN_ORDER_LIFETIME_S) {
      throw new Error(
        "order expiry must provide at least 60 seconds of runway",
      );
    }
    if (expiresAt - issuedAt > ORDER_LIFETIME_S) {
      throw new Error("order lifetime exceeds 48 hours");
    }
    if (
      order.prelock !== undefined &&
      expiresAt > order.prelock.initiatorTimeout
    ) {
      throw new Error(
        "prelocked order proof cannot outlive its initiator lock",
      );
    }
    if (order.prelock !== undefined) {
      const prelockWindow = order.prelock.initiatorTimeout - issuedAt;
      if (
        prelockWindow < MIN_PRELOCK_LISTING_WINDOW_S ||
        prelockWindow > MAX_PRELOCK_LISTING_WINDOW_S
      ) {
        throw new Error(
          "prelocked order timeout is outside the listing window",
        );
      }
    }
    if (options.shareToken !== undefined) {
      throw new Error("public orders cannot carry a share capability");
    }
    const unsignedAuth = {
      issuedAt,
      expiresAt,
      nonce: bytes32(options.nonce ?? nonceHex(), "auth.nonce"),
      makerTokenCommitment: capabilityCommitment(
        MAKER_CAPABILITY_DOMAIN,
        capabilityToken(options.makerToken, "maker token"),
      ),
      shareTokenCommitment: EMPTY_CAPABILITY_COMMITMENT,
    };
    const signature = this.signMessageDigest(
      officialQrlDigest(buildOrderV1Payload(order, unsignedAuth)),
    );
    return {
      order,
      auth: {
        version: "2",
        scheme: "qrl-sign-message-v2",
        ...unsignedAuth,
        signature: hex(signature),
        publicKey: this.publicKey,
        descriptor: OFFICIAL_DESCRIPTOR,
      },
    };
  }

  /**
   * Sign a taker FillIntentV2 for an already authenticated public order.
   * The order proof is re-verified here, the expiry is clamped to the
   * order's own window, and the release commitment is derived from the
   * caller's secret so the walk-away path stays available.
   */
  signFillIntentV1(options: SignFillIntentV1Options): SignedFillIntentV1 {
    this.assertOpen();
    assertPortableOrderV1CanSign(this.address);
    const order = normalizeOrderBody(options.order.order);
    const orderAuth = options.order.auth;
    if (order.visibility !== "public") {
      throw new Error("headless taker supports public signed orders only");
    }
    const orderDigest = computeOrderDigest(order, orderAuth);
    if (bytes32(options.orderDigest, "intent.orderDigest") !== orderDigest) {
      throw new Error("fill intent does not match the verified order digest");
    }
    if (
      !verifyOfficialV1Proof(
        order.makerQrlAccount,
        orderAuth,
        buildOrderV1Payload(order, orderAuth),
      )
    ) {
      throw new Error("order proof is not authenticated by its maker");
    }
    const issuedAt = safeUint(
      options.issuedAt ?? Math.floor(Date.now() / 1000),
      "intent.issuedAt",
    );
    if (issuedAt < orderAuth.issuedAt) {
      throw new Error("fill intent cannot predate its order");
    }
    const expiresAt = Math.min(
      safeUint(
        options.expiresAt ?? issuedAt + MAX_FILL_INTENT_LIFETIME_S,
        "intent.expiresAt",
      ),
      orderAuth.expiresAt,
    );
    if (
      expiresAt <= issuedAt ||
      expiresAt - issuedAt > MAX_FILL_INTENT_LIFETIME_S
    ) {
      throw new Error(
        "fill intent must expire within 120 seconds of issuance and inside its order window",
      );
    }
    const requestNonce = bytes32(
      options.requestNonce ?? nonceHex(),
      "intent.requestNonce",
    );
    const intent: FillIntentV1Body = {
      orderDigest,
      takerEthAccount: ethAddress(
        options.takerEthAccount,
        "intent.takerEthAccount",
      ),
      takerQrlAccount: this.address,
      releaseCommitment: computeReleaseCommitment(
        orderDigest,
        requestNonce,
        bytes32(options.releaseSecret, "intent.releaseSecret"),
      ),
    };
    const unsignedAuth = { issuedAt, expiresAt, nonce: requestNonce };
    const signature = this.signMessageDigest(
      officialQrlDigest(buildFillIntentV1Payload(intent, unsignedAuth)),
    );
    return {
      intent,
      auth: {
        version: "2",
        scheme: "qrl-sign-message-v2",
        ...unsignedAuth,
        signature: hex(signature),
        publicKey: this.publicKey,
        descriptor: OFFICIAL_DESCRIPTOR,
      },
    };
  }

  signFillV1(body: FillV1Body, options: SignFillV1Options): SignedFillV1 {
    this.assertOpen();
    assertPortableOrderV1CanSign(this.address);
    const fill = normalizeFillBody(body);
    const order = normalizeOrderBody(options.order.order);
    const orderAuth = options.order.auth;
    const unsignedAuth = {
      issuedAt: safeUint(
        options.issuedAt ?? Math.floor(Date.now() / 1000),
        "auth.issuedAt",
      ),
      expiresAt: safeUint(options.respondBy, "auth.expiresAt"),
      nonce: bytes32(options.fillNonce ?? nonceHex(), "auth.nonce"),
    };
    const responseWindow = unsignedAuth.expiresAt - unsignedAuth.issuedAt;
    if (
      responseWindow < MIN_FILL_RESPONSE_S ||
      responseWindow > MAX_FILL_RESPONSE_S
    ) {
      throw new Error(
        "fill response window must be between 60 and 900 seconds",
      );
    }
    if (order.visibility !== "public") {
      throw new Error(
        "headless market maker supports public signed orders only",
      );
    }
    if (
      order.makerQrlAccount !== this.address ||
      orderAuth.scheme !== "qrl-sign-message-v2" ||
      orderAuth.publicKey !== this.publicKey ||
      orderAuth.descriptor !== this.descriptor ||
      !verifyOfficialV1Proof(
        order.makerQrlAccount,
        orderAuth,
        buildOrderV1Payload(order, orderAuth),
      )
    ) {
      throw new Error("fill order context is not authenticated by this maker");
    }
    const expectedOrderDigest = computeOrderDigest(order, orderAuth);
    const selected = options.selectedIntent;
    if (
      fill.orderDigest !== expectedOrderDigest ||
      selected.intentDigest !==
        computeFillIntentDigest(selected.intent, selected.auth) ||
      fill.intentDigest !== selected.intentDigest ||
      fill.takerEthAccount !== selected.intent.takerEthAccount ||
      fill.takerQrlAccount !== selected.intent.takerQrlAccount ||
      fill.releaseCommitment !== selected.intent.releaseCommitment ||
      !verifyFillIntentV1(selected.intent, selected.auth, expectedOrderDigest, {
        now: unsignedAuth.issuedAt,
        orderIssuedAt: orderAuth.issuedAt,
        orderExpiresAt: orderAuth.expiresAt,
      })
    ) {
      throw new Error("fill does not authenticate the selected live intent");
    }
    if (
      unsignedAuth.issuedAt >= selected.auth.expiresAt ||
      unsignedAuth.expiresAt > orderAuth.expiresAt
    ) {
      throw new Error(
        "fill authorization is outside its order or intent window",
      );
    }
    if (fill.hashlock === EMPTY_HASHLOCK) {
      throw new Error("fill hashlock cannot be zero");
    }
    const initiatorWindow = fill.initiatorTimeout - unsignedAuth.issuedAt;
    const responderWindow = fill.responderTimeout - unsignedAuth.issuedAt;
    if (
      responderWindow <= 0 ||
      initiatorWindow < responderWindow ||
      responderWindow > Math.floor(initiatorWindow / 2)
    ) {
      throw new Error("fill timeout windows are invalid");
    }
    if (responderWindow > MAX_RESPONDER_WINDOW_S) {
      throw new Error("fill responder timeout exceeds the maximum window");
    }
    if (
      order.prelock === undefined &&
      initiatorWindow > MAX_INITIATOR_WINDOW_S
    ) {
      throw new Error("fill initiator timeout exceeds the maximum window");
    }
    if (
      order.prelock !== undefined &&
      (fill.hashlock !== order.prelock.hashlock ||
        fill.initiatorTimeout !== order.prelock.initiatorTimeout)
    ) {
      throw new Error("fill does not exactly match the signed prelock");
    }
    if (
      fill.responderTimeout - unsignedAuth.expiresAt <=
      MIN_RESPONDER_RUNWAY_AFTER_RESPONSE_S
    ) {
      throw new Error(
        "fill responder timeout has insufficient post-response runway",
      );
    }
    const signature = this.signMessageDigest(
      officialQrlDigest(buildFillV1Payload(fill, orderAuth, unsignedAuth)),
    );
    return {
      fill,
      auth: {
        version: "2",
        scheme: "qrl-sign-message-v2",
        ...unsignedAuth,
        signature: hex(signature),
        publicKey: this.publicKey,
        descriptor: OFFICIAL_DESCRIPTOR,
      },
    };
  }

  signCancelV1(
    body: CancelV1Body,
    options: SignCancelV1Options,
  ): SignedCancelV1 {
    this.assertOpen();
    assertPortableOrderV1CanSign(this.address);
    const cancel = normalizeCancelBody(body);
    const orderAuth = { nonce: bytes32(options.orderNonce, "orderAuth.nonce") };
    const unsignedAuth = {
      issuedAt: safeUint(
        options.issuedAt ?? Math.floor(Date.now() / 1000),
        "auth.issuedAt",
      ),
      expiresAt: safeUint(options.expiresAt, "auth.expiresAt"),
      nonce: bytes32(options.cancelNonce ?? nonceHex(), "auth.nonce"),
    };
    if (unsignedAuth.expiresAt <= unsignedAuth.issuedAt) {
      throw new Error("cancel authorization expiry must follow issuance");
    }
    const signature = this.signMessageDigest(
      officialQrlDigest(buildCancelV1Payload(cancel, orderAuth, unsignedAuth)),
    );
    return {
      cancel,
      auth: {
        version: "2",
        scheme: "qrl-sign-message-v2",
        ...unsignedAuth,
        signature: hex(signature),
        publicKey: this.publicKey,
        descriptor: OFFICIAL_DESCRIPTOR,
      },
    };
  }

  close(): void {
    if (this.closed) return;
    this.wallet.zeroize();
    this.closed = true;
  }

  private signMessageDigest(digest: Uint8Array): Uint8Array {
    assertV2Deployment();
    const secretKey = this.wallet.getSK();
    try {
      const signature = new Uint8Array(CryptoBytes);
      cryptoSignSignature(signature, digest, secretKey, true, SCHEME_TAG_MSG);
      return signature;
    } finally {
      secretKey.fill(0);
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("protocol signer is closed");
  }
}

// V2 entry points. Compatibility names above reject all V1 wire proofs.
export { ORDER_V2_DOMAIN, ORDER_V2_DEPLOYMENT, protocolMessageBytes };
export {
  deriveOrderV1Id as deriveOrderV2Id,
  verifyFillIntentV1 as verifyFillIntentV2,
  verifyOfficialV1Proof as verifyProtocolV2Proof,
};
export type SignedFillIntentV2 = SignedFillIntentV1;
export type ProtocolAuthV2 = ProtocolAuthV1;
export type MakerOrderAuthV2 = MakerOrderAuthV1;
