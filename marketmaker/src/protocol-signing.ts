// Portable ML-DSA-87 protocol proofs for a headless liquidity provider.
// The signed messages are reconstructed from canonical wire bodies. Callers
// never supply an arbitrary typed-data payload to sign.

import { createHash, randomBytes } from "node:crypto";
import {
  ML_DSA_87_PUBLIC_KEY_BYTES,
  ML_DSA_87_SIGNATURE_BYTES,
  verifyTypedDataForSigner,
} from "@qrlwallet/connect";
import { cryptoSignVerify } from "@theqrl/mldsa87";
import {
  Descriptor,
  ExtendedSeed,
  MLDSA87,
  getAddressFromPKAndDescriptor,
} from "@theqrl/wallet.js";
import {
  TypedDataEncoder,
  concat,
  getBytes,
  keccak256,
  toUtf8Bytes,
} from "ethers";
import { isAssetSymbol, type AssetSymbol } from "./assets.js";
import type { Direction } from "./policy.js";

export const ORDER_V1_DOMAIN = {
  name: "QuantaSwap",
  version: "1",
  chainId: "1337",
  salt: "0x1ed0597b5e221ddfd0e541d33a5c14d663f5261645be67c4ee3a4be4d804a740",
} as const;

export const ORDER_V1_DEPLOYMENT = {
  ethChainId: "11155111",
  ethHtlc: "eip155:11155111:0x910d5d4a7f2037c01f3b4c835167357e89909281",
  qrlChainId: "1337",
  qrlHtlc: "Q238322ad2e8f935b4481fcc379779c31b84decb0",
} as const;

export const ORDER_ID_V1_PREFIX = "QuantaSwap OrderV1 id\0";
export const RELEASE_V1_PREFIX = "QuantaSwap ReleaseV1\0";

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

const EIP712_DOMAIN_FIELDS = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "salt", type: "bytes32" },
] as const;

const EMPTY_HASHLOCK = `0x${"00".repeat(32)}`;
export const EMPTY_CAPABILITY_COMMITMENT = `0x${"00".repeat(32)}`;
export const MAKER_CAPABILITY_DOMAIN = "QuantaSwap Maker capability V1\0";
export const SHARE_CAPABILITY_DOMAIN = "QuantaSwap Share capability V1\0";
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
const ZOND_CONTEXT = new TextEncoder().encode("ZOND");
const QRL_MESSAGE_PREFIX = toUtf8Bytes("\x19QRL Signed Message:\n32");
const ETH_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const CAIP_ETH_ADDRESS_RE = /^eip155:11155111:(0x[0-9a-fA-F]{40})$/;
const QRL_ADDRESS_RE = /^Q[0-9a-fA-F]{40}$/;
const AMOUNT_RE = /^(?:0|[1-9][0-9]{0,29})$/;
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;
const CANONICAL_BYTES32_RE = /^0x[0-9a-f]{64}$/;
const CANONICAL_ETH_ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const CANONICAL_QRL_ADDRESS_RE = /^Q[0-9a-f]{40}$/;
const SIGNATURE_RE = new RegExp(`^0x[0-9a-f]{${ML_DSA_87_SIGNATURE_BYTES * 2}}$`);
const PUBLIC_KEY_RE = new RegExp(`^0x[0-9a-f]{${ML_DSA_87_PUBLIC_KEY_BYTES * 2}}$`);
const DESCRIPTOR_RE = /^0x[0-9a-f]{6}$/;
const CAPABILITY_RE = /^[0-9a-f]{64}$/;

export type OrderSigningScheme = "qrl-sign-typed-v1" | "qrl-eip712-v4";

type TypedDataField = { readonly name: string; readonly type: string };

export interface ProtocolTypedDataPayload {
  types: Record<string, readonly TypedDataField[]>;
  primaryType: "OrderV1" | "FillIntentV1" | "FillV1" | "CancelV1";
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

export interface CanonicalOrderV1Body
  extends Omit<OrderV1Body, "visibility" | "prelock"> {
  visibility: "public" | "private";
  prelock?: {
    hashlock: string;
    initiatorTimeout: number;
  };
}

export interface ProtocolAuthV1 {
  version: "1";
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

interface SignCancelV1Options {
  orderNonce: string;
  expiresAt: number;
  issuedAt?: number;
  cancelNonce?: string;
}

type WalletWithCleanup = ReturnType<typeof MLDSA87.newWalletFromExtendedSeed> & {
  zeroize(): void;
};

function hex(bytes: Uint8Array): string {
  return `0x${Buffer.from(bytes).toString("hex")}`;
}

function nonceHex(): string {
  return hex(randomBytes(32));
}

function capabilityToken(value: string, field: string): string {
  if (!CAPABILITY_RE.test(value)) throw new Error(`${field} must be 32 raw bytes as lowercase hex`);
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
  if (!BYTES32_RE.test(value)) throw new Error(`${field} must be a 32-byte hex string`);
  return value.toLowerCase();
}

function safeUint(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
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
  if (!ETH_ADDRESS_RE.test(value)) throw new Error(`${field} must be an Ethereum address`);
  return value.toLowerCase();
}

function caipEthAddress(value: string, field: string): string {
  const caip = CAIP_ETH_ADDRESS_RE.exec(value);
  const address = caip?.[1] ?? value;
  return `eip155:${ORDER_V1_DEPLOYMENT.ethChainId}:${ethAddress(address, field)}`;
}

function qrlAddress(value: string, field: string): string {
  if (!QRL_ADDRESS_RE.test(value)) throw new Error(`${field} must be a QRL address`);
  return `Q${value.slice(1).toLowerCase()}`;
}

function amount(value: string, field: string): string {
  if (!AMOUNT_RE.test(value)) throw new Error(`${field} must be a canonical base-unit amount`);
  return value;
}

function payload(
  primaryType: ProtocolTypedDataPayload["primaryType"],
  fields: readonly TypedDataField[],
  message: Record<string, unknown>,
  scheme: OrderSigningScheme = "qrl-eip712-v4",
): ProtocolTypedDataPayload {
  return {
    types: {
      [scheme === "qrl-sign-typed-v1" ? "QRLDomain" : "EIP712Domain"]: [
        ...EIP712_DOMAIN_FIELDS,
      ],
      [primaryType]: [...fields],
    },
    primaryType,
    domain: { ...ORDER_V1_DOMAIN },
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
  if (visibility === "public" &&
      (body.allowedTakerEth !== undefined || body.allowedTakerQrl !== undefined)) {
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
      : { allowedTakerEth: ethAddress(allowedTakerEth, "order.allowedTakerEth") }),
    ...(allowedTakerQrl === undefined
      ? {}
      : { allowedTakerQrl: qrlAddress(allowedTakerQrl, "order.allowedTakerQrl") }),
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
    "issuedAt" | "expiresAt" | "nonce" | "makerTokenCommitment" | "shareTokenCommitment"
  >,
): Record<string, unknown> {
  return {
    direction: order.direction,
    asset: order.asset,
    fromAmount: order.fromAmount,
    toAmount: order.toAmount,
    makerEthAccount: caipEthAddress(order.makerEthAccount, "order.makerEthAccount"),
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
    "issuedAt" | "expiresAt" | "nonce" | "makerTokenCommitment" | "shareTokenCommitment"
  >,
): ProtocolTypedDataPayload {
  const order = normalizeOrderBody(body);
  return payload("OrderV1", ORDER_V1_FIELDS, orderMessage(order, auth));
}

export function buildFillIntentV1Payload(
  body: FillIntentV1Body,
  auth: Pick<ProtocolAuthV1, "issuedAt" | "expiresAt" | "nonce">,
  scheme: OrderSigningScheme = "qrl-eip712-v4",
): ProtocolTypedDataPayload {
  const issuedAt = safeUint(auth.issuedAt, "intent.issuedAt");
  const expiresAt = safeUint(auth.expiresAt, "intent.expiresAt");
  if (expiresAt <= issuedAt) throw new Error("intent expiry must follow issuance");
  return payload(
    "FillIntentV1",
    FILL_INTENT_V1_FIELDS,
    {
      orderDigest: bytes32(body.orderDigest, "intent.orderDigest"),
      requestNonce: bytes32(auth.nonce, "intent.requestNonce"),
      takerEthAccount: caipEthAddress(body.takerEthAccount, "intent.takerEthAccount"),
      takerQrlAccount: qrlAddress(body.takerQrlAccount, "intent.takerQrlAccount"),
      releaseCommitment: bytes32(body.releaseCommitment, "intent.releaseCommitment"),
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
    releaseCommitment: bytes32(body.releaseCommitment, "fill.releaseCommitment"),
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
  if (respondBy <= issuedAt) throw new Error("fill response deadline must follow issuance");
  return payload("FillV1", FILL_V1_FIELDS, {
    orderDigest: fill.orderDigest,
    intentDigest: fill.intentDigest,
    takerEthAccount: caipEthAddress(fill.takerEthAccount, "fill.takerEthAccount"),
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
  return payload("CancelV1", CANCEL_V1_FIELDS, {
    ...cancel,
    orderNonce: bytes32(orderAuth.nonce, "orderAuth.nonce"),
    cancelNonce: bytes32(auth.nonce, "auth.nonce"),
    issuedAt: String(safeUint(auth.issuedAt, "auth.issuedAt")),
    ...ORDER_V1_DEPLOYMENT,
  });
}

/** A scheme-neutral content digest used to link signed protocol artifacts. */
export function semanticDigest(payloadValue: ProtocolTypedDataPayload): string {
  const fields = payloadValue.types[payloadValue.primaryType];
  if (fields === undefined) throw new Error(`missing ${payloadValue.primaryType} schema`);
  return TypedDataEncoder.hash(
    payloadValue.domain,
    { [payloadValue.primaryType]: [...fields] },
    payloadValue.message,
  );
}

export function computeOrderDigest(
  body: OrderV1Body,
  auth: Pick<
    MakerOrderAuthV1,
    "issuedAt" | "expiresAt" | "nonce" | "makerTokenCommitment" | "shareTokenCommitment"
  >,
): string {
  return semanticDigest(buildOrderV1Payload(body, auth));
}

export function deriveOrderV1Id(makerQrlAccount: string, nonce: string): string {
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
    .update(Buffer.from(bytes32(releaseSecret, "releaseSecret").slice(2), "hex"))
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

/** Apply the official wallet's QRL signed-message wrapper to EIP-712. */
export function officialQrlDigest(payloadValue: ProtocolTypedDataPayload): Uint8Array {
  return getBytes(
    keccak256(concat([QRL_MESSAGE_PREFIX, getBytes(semanticDigest(payloadValue))])),
  );
}

export interface VerifyFillIntentV1Options {
  now?: number;
  orderIssuedAt?: number;
  orderExpiresAt?: number;
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
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
    value["version"] === "1" &&
    (scheme === "qrl-sign-typed-v1" || scheme === "qrl-eip712-v4") &&
    typeof issuedAt === "number" &&
    Number.isSafeInteger(issuedAt) &&
    issuedAt >= 0 &&
    typeof expiresAt === "number" &&
    Number.isSafeInteger(expiresAt) &&
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
    DESCRIPTOR_RE.test(descriptor) &&
    (scheme !== "qrl-eip712-v4" || descriptor === OFFICIAL_DESCRIPTOR)
  );
}

function publicKeyMatchesSigner(
  signer: string,
  descriptorHex: string,
  publicKeyHex: string,
): boolean {
  const descriptor = Descriptor.from(getBytes(descriptorHex));
  const address = getAddressFromPKAndDescriptor(getBytes(publicKeyHex), descriptor);
  return `Q${Buffer.from(address).toString("hex")}` === signer;
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
    if (!fillIntentBodyIsCanonical(body) || !protocolAuthIsCanonical(auth, now)) {
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
    if (!publicKeyMatchesSigner(body.takerQrlAccount, auth.descriptor, auth.publicKey)) {
      return false;
    }

    const payloadValue = buildFillIntentV1Payload(body, auth, auth.scheme);
    if (auth.scheme === "qrl-sign-typed-v1") {
      return verifyTypedDataForSigner({
        expectedSigner: body.takerQrlAccount,
        descriptor: auth.descriptor,
        signature: auth.signature,
        publicKey: auth.publicKey,
        payload: payloadValue,
      });
    }
    return cryptoSignVerify(
      getBytes(auth.signature),
      officialQrlDigest(payloadValue),
      getBytes(auth.publicKey),
      ZOND_CONTEXT,
    );
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
    this.address = qrlAddress(this.wallet.getAddressStr(), "derived QRL address");
    this.publicKey = hex(this.wallet.getPK());
  }

  signOrderV1(body: OrderV1Body, options: SignOrderV1Options): SignedOrderV1 {
    this.assertOpen();
    const order = normalizeOrderBody(body);
    if (order.visibility !== "public") {
      throw new Error("headless market maker supports public signed orders only");
    }
    if (order.makerQrlAccount !== this.address) {
      throw new Error("order maker QRL account does not match the signing seed");
    }
    const issuedAt = safeUint(options.issuedAt ?? Math.floor(Date.now() / 1000), "auth.issuedAt");
    const defaultExpiry = Math.min(
      issuedAt + ORDER_LIFETIME_S,
      order.prelock?.initiatorTimeout ?? Number.POSITIVE_INFINITY,
    );
    const expiresAt = safeUint(options.expiresAt ?? defaultExpiry, "auth.expiresAt");
    if (expiresAt - issuedAt < MIN_ORDER_LIFETIME_S) {
      throw new Error("order expiry must provide at least 60 seconds of runway");
    }
    if (expiresAt - issuedAt > ORDER_LIFETIME_S) {
      throw new Error("order lifetime exceeds 48 hours");
    }
    if (order.prelock !== undefined && expiresAt > order.prelock.initiatorTimeout) {
      throw new Error("prelocked order proof cannot outlive its initiator lock");
    }
    if (order.prelock !== undefined) {
      const prelockWindow = order.prelock.initiatorTimeout - issuedAt;
      if (
        prelockWindow < MIN_PRELOCK_LISTING_WINDOW_S ||
        prelockWindow > MAX_PRELOCK_LISTING_WINDOW_S
      ) {
        throw new Error("prelocked order timeout is outside the listing window");
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
    const signature = this.wallet.sign(officialQrlDigest(buildOrderV1Payload(order, unsignedAuth)));
    return {
      order,
      auth: {
        version: "1",
        scheme: "qrl-eip712-v4",
        ...unsignedAuth,
        signature: hex(signature),
        publicKey: this.publicKey,
        descriptor: OFFICIAL_DESCRIPTOR,
      },
    };
  }

  signFillV1(body: FillV1Body, options: SignFillV1Options): SignedFillV1 {
    this.assertOpen();
    const fill = normalizeFillBody(body);
    const order = normalizeOrderBody(options.order.order);
    const orderAuth = options.order.auth;
    const unsignedAuth = {
      issuedAt: safeUint(options.issuedAt ?? Math.floor(Date.now() / 1000), "auth.issuedAt"),
      expiresAt: safeUint(options.respondBy, "auth.expiresAt"),
      nonce: bytes32(options.fillNonce ?? nonceHex(), "auth.nonce"),
    };
    const responseWindow = unsignedAuth.expiresAt - unsignedAuth.issuedAt;
    if (responseWindow < MIN_FILL_RESPONSE_S || responseWindow > MAX_FILL_RESPONSE_S) {
      throw new Error("fill response window must be between 60 and 900 seconds");
    }
    if (order.visibility !== "public") {
      throw new Error("headless market maker supports public signed orders only");
    }
    if (
      order.makerQrlAccount !== this.address ||
      orderAuth.scheme !== "qrl-eip712-v4" ||
      orderAuth.publicKey !== this.publicKey ||
      orderAuth.descriptor !== this.descriptor ||
      !MLDSA87.verify(
        getBytes(orderAuth.signature),
        officialQrlDigest(buildOrderV1Payload(order, orderAuth)),
        getBytes(orderAuth.publicKey),
      )
    ) {
      throw new Error("fill order context is not authenticated by this maker");
    }
    const expectedOrderDigest = computeOrderDigest(order, orderAuth);
    const selected = options.selectedIntent;
    if (
      fill.orderDigest !== expectedOrderDigest ||
      selected.intentDigest !== computeFillIntentDigest(selected.intent, selected.auth) ||
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
      throw new Error("fill authorization is outside its order or intent window");
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
    if (order.prelock === undefined && initiatorWindow > MAX_INITIATOR_WINDOW_S) {
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
      throw new Error("fill responder timeout has insufficient post-response runway");
    }
    const signature = this.wallet.sign(
      officialQrlDigest(buildFillV1Payload(fill, orderAuth, unsignedAuth)),
    );
    return {
      fill,
      auth: {
        version: "1",
        scheme: "qrl-eip712-v4",
        ...unsignedAuth,
        signature: hex(signature),
        publicKey: this.publicKey,
        descriptor: OFFICIAL_DESCRIPTOR,
      },
    };
  }

  signCancelV1(body: CancelV1Body, options: SignCancelV1Options): SignedCancelV1 {
    this.assertOpen();
    const cancel = normalizeCancelBody(body);
    const orderAuth = { nonce: bytes32(options.orderNonce, "orderAuth.nonce") };
    const unsignedAuth = {
      issuedAt: safeUint(options.issuedAt ?? Math.floor(Date.now() / 1000), "auth.issuedAt"),
      expiresAt: safeUint(options.expiresAt, "auth.expiresAt"),
      nonce: bytes32(options.cancelNonce ?? nonceHex(), "auth.nonce"),
    };
    if (unsignedAuth.expiresAt <= unsignedAuth.issuedAt) {
      throw new Error("cancel authorization expiry must follow issuance");
    }
    const signature = this.wallet.sign(
      officialQrlDigest(buildCancelV1Payload(cancel, orderAuth, unsignedAuth)),
    );
    return {
      cancel,
      auth: {
        version: "1",
        scheme: "qrl-eip712-v4",
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

  private assertOpen(): void {
    if (this.closed) throw new Error("protocol signer is closed");
  }
}
