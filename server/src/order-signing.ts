// Portable maker authorization for OrderV1. The order book reconstructs the
// payload from the submitted economic terms and verifies the ML-DSA-87 proof;
// it never accepts an arbitrary wallet-supplied payload as authoritative.

import { sha256 } from "@noble/hashes/sha2.js";
import { shake256, keccak_256 } from "@noble/hashes/sha3.js";
import {
  ML_DSA_87_PUBLIC_KEY_BYTES,
  ML_DSA_87_SIGNATURE_BYTES,
  verifyTypedDataForSigner,
  type TypedDataPayload,
} from "@qrlwallet/connect";
import { cryptoSignVerify } from "@theqrl/mldsa87";
import { TypedDataEncoder, getBytes } from "ethers";
import { isKnownAsset } from "./assets.js";
import { ApiError } from "./errors.js";

export const ORDER_V1_DOMAIN = {
  name: "QuantaSwap",
  version: "1",
  chainId: "1337",
  salt: "0x1ed0597b5e221ddfd0e541d33a5c14d663f5261645be67c4ee3a4be4d804a740",
} as const;

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

export const ORDER_V1_DEPLOYMENT = {
  ethChainId: "11155111",
  ethHtlc: "eip155:11155111:0x910d5d4a7f2037c01f3b4c835167357e89909281",
  qrlChainId: "1337",
  qrlHtlc: "Q238322ad2e8f935b4481fcc379779c31b84decb0",
} as const;

export type OrderSigningScheme = "qrl-sign-typed-v1" | "qrl-eip712-v4";

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

export interface ProtocolVerificationOptions {
  now?: number;
  allowExpired?: boolean;
}

export interface ProtocolDeploymentTerms extends Record<string, unknown> {
  ethChainId: string;
  ethHtlc: string;
  qrlChainId: string;
  qrlHtlc: string;
}

export interface SignedOrderBaseTerms extends ProtocolDeploymentTerms {
  direction: "eth->qrl" | "qrl->eth";
  asset: "ETH" | "USDC" | "tUSDT";
  fromAmount: string;
  toAmount: string;
  makerEthAccount: string;
  makerQrlAccount: string;
  visibility: "public" | "private";
  allowedTakerEth: string;
  allowedTakerQrl: string;
  prelocked: boolean;
  hashlock: string;
  initiatorTimeout: string;
}

export interface SignedOrderTerms extends SignedOrderBaseTerms {
  issuedAt: string;
  expiresAt: string;
  nonce: string;
  makerTokenCommitment: string;
  shareTokenCommitment: string;
}

export interface VerifiedOrderV1 {
  orderId: string;
  orderDigest: string;
  order: Record<string, unknown>;
  auth: MakerOrderAuthV1;
  terms: SignedOrderTerms;
}

export interface FillIntentV1Body extends Record<string, unknown> {
  orderDigest: string;
  takerEthAccount: string;
  takerQrlAccount: string;
  releaseCommitment: string;
}

export interface FillIntentV1Terms extends ProtocolDeploymentTerms {
  orderDigest: string;
  takerEthAccount: string;
  takerQrlAccount: string;
  releaseCommitment: string;
  issuedAt: string;
  expiresAt: string;
  requestNonce: string;
}

export interface VerifiedFillIntentV1 {
  intentDigest: string;
  intent: FillIntentV1Body;
  auth: ProtocolAuthV1;
  terms: FillIntentV1Terms;
}

export interface FillV1Body extends Record<string, unknown> {
  orderDigest: string;
  intentDigest: string;
  takerEthAccount: string;
  takerQrlAccount: string;
  releaseCommitment: string;
  hashlock: string;
  initiatorTimeout: number;
  responderTimeout: number;
}

export interface FillV1Terms extends ProtocolDeploymentTerms {
  orderDigest: string;
  intentDigest: string;
  takerEthAccount: string;
  takerQrlAccount: string;
  releaseCommitment: string;
  hashlock: string;
  initiatorTimeout: string;
  responderTimeout: string;
  orderNonce: string;
  fillNonce: string;
  issuedAt: string;
  respondBy: string;
}

export interface VerifiedFillV1 {
  fillDigest: string;
  fill: FillV1Body;
  auth: ProtocolAuthV1;
  terms: FillV1Terms;
}

export interface CancelV1Body extends Record<string, unknown> {
  orderDigest: string;
  reasonCode: number;
}

export interface CancelV1Terms extends ProtocolDeploymentTerms {
  orderDigest: string;
  reasonCode: number;
  orderNonce: string;
  cancelNonce: string;
  issuedAt: string;
}

export interface VerifiedCancelV1 {
  cancelDigest: string;
  cancel: CancelV1Body;
  auth: ProtocolAuthV1;
  terms: CancelV1Terms;
}

const ETH_ADDR_RE = /^0x[0-9a-f]{40}$/;
const QRL_ADDR_RE = /^Q[0-9a-f]{40}$/;
const HASHLOCK_RE = /^0x[0-9a-f]{64}$/;
const BYTES32_RE = /^0x[0-9a-f]{64}$/;
const AMOUNT_RE = /^(?:0|[1-9][0-9]{0,29})$/;
const SIGNATURE_RE = new RegExp(`^0x[0-9a-f]{${ML_DSA_87_SIGNATURE_BYTES * 2}}$`);
const PUBLIC_KEY_RE = new RegExp(`^0x[0-9a-f]{${ML_DSA_87_PUBLIC_KEY_BYTES * 2}}$`);
const DESCRIPTOR_RE = /^0x[0-9a-f]{6}$/;
const EMPTY_HASHLOCK = `0x${"00".repeat(32)}`;
const MAX_ORDER_LIFETIME_S = 48 * 3600;
const MAX_FILL_INTENT_LIFETIME_S = 120;
const MIN_FILL_RESPONSE_S = 60;
const MAX_FILL_RESPONSE_S = 900;
const MIN_RESPONDER_RUNWAY_AFTER_RESPONSE_S = 600;
const MIN_PRELOCK_RUNWAY_S = 9_000;
const MAX_RESPONDER_WINDOW_S = 2 * 60 * 60;
const MAX_INITIATOR_WINDOW_S = 4 * 60 * 60;
const MIN_PRELOCK_LISTING_WINDOW_S = 3 * 60 * 60;
const MAX_PRELOCK_LISTING_WINDOW_S = 72 * 60 * 60;
const MAX_CLOCK_SKEW_S = 5 * 60;
const MIN_REMAINING_LIFETIME_S = 60;
const ZOND_CONTEXT = new TextEncoder().encode("ZOND");
const QRL_MESSAGE_PREFIX = new TextEncoder().encode("\x19QRL Signed Message:\n32");
const OFFICIAL_DESCRIPTOR = "0x010000";
export const RELEASE_V1_PREFIX = "QuantaSwap ReleaseV1\0";
const RELEASE_V1_PREFIX_BYTES = new TextEncoder().encode(RELEASE_V1_PREFIX);
export const ORDER_ID_V1_PREFIX = "QuantaSwap OrderV1 id\0";
const ORDER_ID_V1_PREFIX_BYTES = new TextEncoder().encode(ORDER_ID_V1_PREFIX);
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
const MAKER_ORDER_AUTH_KEYS = [
  ...PROTOCOL_AUTH_KEYS,
  "makerTokenCommitment",
  "shareTokenCommitment",
] as const;
const ZERO_BYTES32 = `0x${"00".repeat(32)}`;
const MAKER_CAPABILITY_V1_PREFIX = new TextEncoder().encode(
  "QuantaSwap Maker capability V1\0",
);
const SHARE_CAPABILITY_V1_PREFIX = new TextEncoder().encode(
  "QuantaSwap Share capability V1\0",
);
const RAW_CAPABILITY_RE = /^[0-9a-f]{64}$/;

function invalid(message: string): never {
  throw new ApiError(400, message);
}

function objectValue(raw: unknown, field: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    invalid(`${field} must be an object`);
  }
  return raw as Record<string, unknown>;
}

function exactObject(
  raw: unknown,
  field: string,
  keys: readonly string[],
): Record<string, unknown> {
  const object = objectValue(raw, field);
  const allowed = new Set(keys);
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) invalid(`${field}.${key} is not supported`);
  }
  for (const key of keys) {
    if (!(key in object)) invalid(`${field}.${key} is required`);
  }
  return object;
}

function allowedObject(
  raw: unknown,
  field: string,
  keys: readonly string[],
): Record<string, unknown> {
  const object = objectValue(raw, field);
  const allowed = new Set(keys);
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) invalid(`${field}.${key} is not supported`);
  }
  return object;
}

function exactString(
  raw: unknown,
  field: string,
  pattern: RegExp,
): string {
  if (typeof raw !== "string" || !pattern.test(raw)) invalid(`${field} is invalid`);
  return raw;
}

function exactInteger(raw: unknown, field: string): number {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) {
    invalid(`${field} must be a non-negative safe integer`);
  }
  return raw;
}

function exactUint8(raw: unknown, field: string): number {
  const value = exactInteger(raw, field);
  if (value > 255) invalid(`${field} must fit uint8`);
  return value;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function canonicalOrderBody(raw: unknown): {
  body: Record<string, unknown>;
  terms: SignedOrderBaseTerms;
} {
  const input = allowedObject(raw, "order", [
    "direction",
    "asset",
    "fromAmount",
    "toAmount",
    "makerEthAccount",
    "makerQrlAccount",
    "visibility",
    "allowedTakerEth",
    "allowedTakerQrl",
    "prelock",
  ]);
  const direction = input["direction"];
  if (direction !== "eth->qrl" && direction !== "qrl->eth") {
    invalid("order.direction is invalid");
  }
  const asset = input["asset"];
  if (typeof asset !== "string" || !isKnownAsset(asset)) invalid("order.asset is invalid");
  const fromAmount = exactString(input["fromAmount"], "order.fromAmount", AMOUNT_RE);
  const toAmount = exactString(input["toAmount"], "order.toAmount", AMOUNT_RE);
  const makerEthAccount = exactString(
    input["makerEthAccount"],
    "order.makerEthAccount",
    ETH_ADDR_RE,
  );
  const makerQrlAccount = exactString(
    input["makerQrlAccount"],
    "order.makerQrlAccount",
    QRL_ADDR_RE,
  );
  const visibility = input["visibility"];
  if (visibility !== "public" && visibility !== "private") {
    invalid("order.visibility is invalid");
  }

  let allowedTakerEth = "";
  let allowedTakerQrl = "";
  if (visibility === "private") {
    if (input["allowedTakerEth"] !== undefined) {
      allowedTakerEth = exactString(
        input["allowedTakerEth"],
        "order.allowedTakerEth",
        ETH_ADDR_RE,
      );
    }
    if (input["allowedTakerQrl"] !== undefined) {
      allowedTakerQrl = exactString(
        input["allowedTakerQrl"],
        "order.allowedTakerQrl",
        QRL_ADDR_RE,
      );
    }
  } else if (
    input["allowedTakerEth"] !== undefined ||
    input["allowedTakerQrl"] !== undefined
  ) {
    invalid("public signed orders cannot restrict the taker");
  }

  let prelocked = false;
  let hashlock = EMPTY_HASHLOCK;
  let initiatorTimeout = "0";
  let prelockBody: { hashlock: string; initiatorTimeout: number } | undefined;
  if (input["prelock"] !== undefined) {
    const prelock = exactObject(input["prelock"], "order.prelock", [
      "hashlock",
      "initiatorTimeout",
    ]);
    prelocked = true;
    hashlock = exactString(prelock["hashlock"], "order.prelock.hashlock", HASHLOCK_RE);
    const timeout = exactInteger(
      prelock["initiatorTimeout"],
      "order.prelock.initiatorTimeout",
    );
    initiatorTimeout = String(timeout);
    prelockBody = { hashlock, initiatorTimeout: timeout };
  }

  const body: Record<string, unknown> = {
    direction,
    asset,
    fromAmount,
    toAmount,
    makerEthAccount,
    makerQrlAccount,
    visibility,
    ...(allowedTakerEth === "" ? {} : { allowedTakerEth }),
    ...(allowedTakerQrl === "" ? {} : { allowedTakerQrl }),
    ...(prelockBody === undefined ? {} : { prelock: prelockBody }),
  };

  return {
    body,
    terms: {
      direction,
      asset,
      fromAmount,
      toAmount,
      makerEthAccount: `eip155:${ORDER_V1_DEPLOYMENT.ethChainId}:${makerEthAccount}`,
      makerQrlAccount,
      visibility,
      allowedTakerEth:
        allowedTakerEth === ""
          ? ""
          : `eip155:${ORDER_V1_DEPLOYMENT.ethChainId}:${allowedTakerEth}`,
      allowedTakerQrl,
      prelocked,
      hashlock,
      initiatorTimeout,
      ...ORDER_V1_DEPLOYMENT,
    },
  };
}

export function deriveOrderV1Id(makerQrlAccount: string, nonce: string): string {
  if (!QRL_ADDR_RE.test(makerQrlAccount) || !BYTES32_RE.test(nonce)) {
    invalid("OrderV1 identity is invalid");
  }
  return Buffer.from(
    sha256(
      concatBytes(
        ORDER_ID_V1_PREFIX_BYTES,
        getBytes(`0x${makerQrlAccount.slice(1)}`),
        getBytes(nonce),
      ),
    ),
  ).toString("hex");
}

function capabilityCommitment(rawToken: string, prefix: Uint8Array, field: string): string {
  if (!RAW_CAPABILITY_RE.test(rawToken)) invalid(`${field} is invalid`);
  const digest = sha256(concatBytes(prefix, getBytes(`0x${rawToken}`)));
  return `0x${Buffer.from(digest).toString("hex")}`;
}

export function computeMakerTokenCommitment(rawToken: string): string {
  return capabilityCommitment(
    rawToken,
    MAKER_CAPABILITY_V1_PREFIX,
    "makerToken",
  );
}

export function computeShareTokenCommitment(rawToken: string): string {
  return capabilityCommitment(
    rawToken,
    SHARE_CAPABILITY_V1_PREFIX,
    "shareToken",
  );
}

function parseAuth(
  raw: unknown,
  field = "auth",
  exact = false,
): ProtocolAuthV1 {
  const auth = exact
    ? exactObject(raw, field, PROTOCOL_AUTH_KEYS)
    : objectValue(raw, field);
  if (auth["version"] !== "1") invalid(`${field}.version must be 1`);
  const scheme = auth["scheme"];
  if (scheme !== "qrl-sign-typed-v1" && scheme !== "qrl-eip712-v4") {
    invalid(`${field}.scheme is unsupported`);
  }
  const descriptor = exactString(auth["descriptor"], `${field}.descriptor`, DESCRIPTOR_RE);
  if (scheme === "qrl-eip712-v4" && descriptor !== OFFICIAL_DESCRIPTOR) {
    invalid(`${field} official-wallet proofs require descriptor 0x010000`);
  }
  return {
    version: "1",
    scheme,
    issuedAt: exactInteger(auth["issuedAt"], `${field}.issuedAt`),
    expiresAt: exactInteger(auth["expiresAt"], `${field}.expiresAt`),
    nonce: exactString(auth["nonce"], `${field}.nonce`, BYTES32_RE),
    signature: exactString(auth["signature"], `${field}.signature`, SIGNATURE_RE),
    publicKey: exactString(auth["publicKey"], `${field}.publicKey`, PUBLIC_KEY_RE),
    descriptor,
  };
}

function parseMakerOrderAuth(raw: unknown): MakerOrderAuthV1 {
  const exact = exactObject(raw, "auth", MAKER_ORDER_AUTH_KEYS);
  return {
    ...parseAuth(exact),
    makerTokenCommitment: exactString(
      exact["makerTokenCommitment"],
      "auth.makerTokenCommitment",
      BYTES32_RE,
    ),
    shareTokenCommitment: exactString(
      exact["shareTokenCommitment"],
      "auth.shareTokenCommitment",
      BYTES32_RE,
    ),
  };
}

const DOMAIN_FIELDS = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "salt", type: "bytes32" },
] as const;

function buildPayload(
  primaryType: string,
  fields: readonly { name: string; type: string }[],
  terms: Record<string, unknown>,
  scheme: OrderSigningScheme,
): TypedDataPayload {
  return {
    types: {
      [scheme === "qrl-sign-typed-v1" ? "QRLDomain" : "EIP712Domain"]: [...DOMAIN_FIELDS],
      [primaryType]: [...fields],
    },
    primaryType,
    domain: { ...ORDER_V1_DOMAIN },
    message: terms,
  };
}

function semanticDigest(
  primaryType: string,
  fields: readonly { name: string; type: string }[],
  terms: Record<string, unknown>,
): string {
  return TypedDataEncoder.hash(
    ORDER_V1_DOMAIN,
    { [primaryType]: [...fields] },
    terms,
  );
}

export function buildOrderV1Payload(
  terms: SignedOrderTerms,
  scheme: OrderSigningScheme,
): TypedDataPayload {
  return buildPayload("OrderV1", ORDER_V1_FIELDS, terms, scheme);
}

export function buildFillIntentV1Payload(
  terms: FillIntentV1Terms,
  scheme: OrderSigningScheme,
): TypedDataPayload {
  return buildPayload("FillIntentV1", FILL_INTENT_V1_FIELDS, terms, scheme);
}

export function buildFillV1Payload(
  terms: FillV1Terms,
  scheme: OrderSigningScheme,
): TypedDataPayload {
  return buildPayload("FillV1", FILL_V1_FIELDS, terms, scheme);
}

export function buildCancelV1Payload(
  terms: CancelV1Terms,
  scheme: OrderSigningScheme,
): TypedDataPayload {
  return buildPayload("CancelV1", CANCEL_V1_FIELDS, terms, scheme);
}

export function orderDigest(terms: SignedOrderTerms): string {
  return semanticDigest("OrderV1", ORDER_V1_FIELDS, terms);
}

export function intentDigest(terms: FillIntentV1Terms): string {
  return semanticDigest("FillIntentV1", FILL_INTENT_V1_FIELDS, terms);
}

export function fillDigest(terms: FillV1Terms): string {
  return semanticDigest("FillV1", FILL_V1_FIELDS, terms);
}

export function cancelDigest(terms: CancelV1Terms): string {
  return semanticDigest("CancelV1", CANCEL_V1_FIELDS, terms);
}

export function computeReleaseCommitment(
  orderDigestValue: string,
  requestNonce: string,
  releaseSecret: string,
): string {
  const canonicalOrderDigest = exactString(
    orderDigestValue,
    "orderDigest",
    BYTES32_RE,
  );
  const canonicalRequestNonce = exactString(requestNonce, "requestNonce", BYTES32_RE);
  const canonicalReleaseSecret = exactString(releaseSecret, "releaseSecret", BYTES32_RE);
  const digest = sha256(
    concatBytes(
      RELEASE_V1_PREFIX_BYTES,
      getBytes(canonicalOrderDigest),
      getBytes(canonicalRequestNonce),
      getBytes(canonicalReleaseSecret),
    ),
  );
  return `0x${Buffer.from(digest).toString("hex")}`;
}

function publicKeyMatchesSigner(
  signer: string,
  descriptorHex: string,
  publicKeyHex: string,
): boolean {
  const descriptor = getBytes(descriptorHex);
  if (descriptor[0] !== 1) return false;
  const address = shake256(concatBytes(descriptor, getBytes(publicKeyHex)), { dkLen: 20 });
  const derived = `Q${Buffer.from(address).toString("hex")}`;
  return derived === signer;
}

function officialDigest(payload: TypedDataPayload): Uint8Array {
  const fields = payload.types[payload.primaryType];
  if (fields === undefined) return new Uint8Array();
  const eip712 = TypedDataEncoder.hash(
    payload.domain,
    { [payload.primaryType]: [...fields] },
    payload.message,
  );
  return keccak_256(concatBytes(QRL_MESSAGE_PREFIX, getBytes(eip712)));
}

function verifyProof(
  signer: string,
  auth: ProtocolAuthV1,
  payload: TypedDataPayload,
): boolean {
  if (auth.scheme === "qrl-sign-typed-v1") {
    return verifyTypedDataForSigner({
      expectedSigner: signer,
      descriptor: auth.descriptor,
      signature: auth.signature,
      publicKey: auth.publicKey,
      payload,
    });
  }
  return (
    publicKeyMatchesSigner(signer, auth.descriptor, auth.publicKey) &&
    cryptoSignVerify(
      getBytes(auth.signature),
      officialDigest(payload),
      getBytes(auth.publicKey),
      ZOND_CONTEXT,
    )
  );
}

export function verifyOrderV1(
  rawOrder: unknown,
  rawAuth: unknown,
  options: ProtocolVerificationOptions = {},
): VerifiedOrderV1 {
  const { body, terms: baseTerms } = canonicalOrderBody(rawOrder);
  const auth = parseMakerOrderAuth(rawAuth);
  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (auth.expiresAt <= auth.issuedAt) invalid("signed order expiry must follow issuance");
  if (auth.expiresAt - auth.issuedAt > MAX_ORDER_LIFETIME_S) {
    invalid("signed order lifetime exceeds 48 hours");
  }
  if (auth.issuedAt > now + MAX_CLOCK_SKEW_S) invalid("signed order issuance is in the future");
  if (!options.allowExpired && auth.expiresAt < now + MIN_REMAINING_LIFETIME_S) {
    invalid("signed order is expired or too close to expiry");
  }
  if (baseTerms.prelocked && auth.expiresAt > Number(baseTerms.initiatorTimeout)) {
    invalid("signed order expiry exceeds the prelock timeout");
  }
  if (baseTerms.prelocked) {
    const prelockWindow = Number(baseTerms.initiatorTimeout) - auth.issuedAt;
    if (
      prelockWindow < MIN_PRELOCK_LISTING_WINDOW_S ||
      prelockWindow > MAX_PRELOCK_LISTING_WINDOW_S
    ) {
      invalid("signed prelock timeout is outside the listing window");
    }
  }

  if (auth.makerTokenCommitment === ZERO_BYTES32) {
    invalid("auth.makerTokenCommitment cannot be zero");
  }
  if (
    (baseTerms.visibility === "public" &&
      auth.shareTokenCommitment !== ZERO_BYTES32) ||
    (baseTerms.visibility === "private" &&
      auth.shareTokenCommitment === ZERO_BYTES32)
  ) {
    invalid("auth.shareTokenCommitment does not match order visibility");
  }

  const terms: SignedOrderTerms = {
    ...baseTerms,
    issuedAt: String(auth.issuedAt),
    expiresAt: String(auth.expiresAt),
    nonce: auth.nonce,
    makerTokenCommitment: auth.makerTokenCommitment,
    shareTokenCommitment: auth.shareTokenCommitment,
  };
  const payload = buildOrderV1Payload(terms, auth.scheme);
  if (!verifyProof(terms.makerQrlAccount, auth, payload)) {
    throw new ApiError(401, "maker signature is invalid");
  }

  return {
    orderId: deriveOrderV1Id(baseTerms.makerQrlAccount, auth.nonce),
    orderDigest: orderDigest(terms),
    order: body,
    auth,
    terms,
  };
}

function canonicalFillIntentBody(raw: unknown): FillIntentV1Body {
  const body = exactObject(raw, "intent", [
    "orderDigest",
    "takerEthAccount",
    "takerQrlAccount",
    "releaseCommitment",
  ]);
  return {
    orderDigest: exactString(body["orderDigest"], "intent.orderDigest", BYTES32_RE),
    takerEthAccount: exactString(
      body["takerEthAccount"],
      "intent.takerEthAccount",
      ETH_ADDR_RE,
    ),
    takerQrlAccount: exactString(
      body["takerQrlAccount"],
      "intent.takerQrlAccount",
      QRL_ADDR_RE,
    ),
    releaseCommitment: exactString(
      body["releaseCommitment"],
      "intent.releaseCommitment",
      BYTES32_RE,
    ),
  };
}

function canonicalFillBody(raw: unknown): FillV1Body {
  const body = exactObject(raw, "fill", [
    "orderDigest",
    "intentDigest",
    "takerEthAccount",
    "takerQrlAccount",
    "releaseCommitment",
    "hashlock",
    "initiatorTimeout",
    "responderTimeout",
  ]);
  const hashlock = exactString(body["hashlock"], "fill.hashlock", HASHLOCK_RE);
  if (hashlock === EMPTY_HASHLOCK) invalid("fill.hashlock cannot be zero");
  return {
    orderDigest: exactString(body["orderDigest"], "fill.orderDigest", BYTES32_RE),
    intentDigest: exactString(body["intentDigest"], "fill.intentDigest", BYTES32_RE),
    takerEthAccount: exactString(
      body["takerEthAccount"],
      "fill.takerEthAccount",
      ETH_ADDR_RE,
    ),
    takerQrlAccount: exactString(
      body["takerQrlAccount"],
      "fill.takerQrlAccount",
      QRL_ADDR_RE,
    ),
    releaseCommitment: exactString(
      body["releaseCommitment"],
      "fill.releaseCommitment",
      BYTES32_RE,
    ),
    hashlock,
    initiatorTimeout: exactInteger(body["initiatorTimeout"], "fill.initiatorTimeout"),
    responderTimeout: exactInteger(body["responderTimeout"], "fill.responderTimeout"),
  };
}

function canonicalCancelBody(raw: unknown): CancelV1Body {
  const body = exactObject(raw, "cancel", ["orderDigest", "reasonCode"]);
  return {
    orderDigest: exactString(body["orderDigest"], "cancel.orderDigest", BYTES32_RE),
    reasonCode: exactUint8(body["reasonCode"], "cancel.reasonCode"),
  };
}

function assertInitialAcceptance(
  auth: ProtocolAuthV1,
  now: number,
  artifact: string,
  allowExpired: boolean,
): void {
  if (auth.issuedAt > now + MAX_CLOCK_SKEW_S) {
    invalid(`${artifact} issuance is in the future`);
  }
  if (!allowExpired && auth.expiresAt <= now) invalid(`${artifact} is expired`);
}

function assertOrderValidity(
  order: VerifiedOrderV1,
  artifactIssuedAt: number,
  now: number,
  allowExpired: boolean,
): void {
  if (!allowExpired && now >= order.auth.expiresAt) invalid("referenced order is expired");
  if (
    artifactIssuedAt < order.auth.issuedAt ||
    artifactIssuedAt >= order.auth.expiresAt
  ) {
    invalid("artifact issuance falls outside the order validity window");
  }
}

function caipEthAccount(account: string): string {
  return `eip155:${ORDER_V1_DEPLOYMENT.ethChainId}:${account}`;
}

function assertOrderReference(order: VerifiedOrderV1, digest: string): void {
  if (digest !== order.orderDigest) invalid("orderDigest does not match the signed order");
}

function assertAllowedTaker(order: VerifiedOrderV1, eth: string, qrl: string): void {
  if (order.terms.allowedTakerEth !== "" && order.terms.allowedTakerEth !== eth) {
    invalid("taker ETH account is not allowed by the signed order");
  }
  if (order.terms.allowedTakerQrl !== "" && order.terms.allowedTakerQrl !== qrl) {
    invalid("taker QRL account is not allowed by the signed order");
  }
}

export function verifyFillIntentV1(
  rawIntent: unknown,
  rawAuth: unknown,
  order: VerifiedOrderV1,
  options: ProtocolVerificationOptions = {},
): VerifiedFillIntentV1 {
  const intent = canonicalFillIntentBody(rawIntent);
  const auth = parseAuth(rawAuth, "auth", true);
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const allowExpired = options.allowExpired ?? false;
  assertOrderReference(order, intent.orderDigest);
  assertOrderValidity(order, auth.issuedAt, now, allowExpired);
  if (auth.expiresAt <= auth.issuedAt) {
    invalid("fill intent expiry must follow issuance");
  }
  if (auth.expiresAt - auth.issuedAt > MAX_FILL_INTENT_LIFETIME_S) {
    invalid("fill intent lifetime exceeds 120 seconds");
  }
  if (auth.expiresAt > order.auth.expiresAt) {
    invalid("fill intent expiry exceeds the order validity window");
  }
  assertInitialAcceptance(auth, now, "fill intent", allowExpired);

  const takerEthAccount = caipEthAccount(intent.takerEthAccount);
  assertAllowedTaker(order, takerEthAccount, intent.takerQrlAccount);
  const terms: FillIntentV1Terms = {
    orderDigest: intent.orderDigest,
    requestNonce: auth.nonce,
    takerEthAccount,
    takerQrlAccount: intent.takerQrlAccount,
    releaseCommitment: intent.releaseCommitment,
    issuedAt: String(auth.issuedAt),
    expiresAt: String(auth.expiresAt),
    ...ORDER_V1_DEPLOYMENT,
  };
  const payload = buildFillIntentV1Payload(terms, auth.scheme);
  if (!verifyProof(intent.takerQrlAccount, auth, payload)) {
    throw new ApiError(401, "taker signature is invalid");
  }

  return {
    intentDigest: intentDigest(terms),
    intent,
    auth,
    terms,
  };
}

export function verifyFillV1(
  rawFill: unknown,
  rawAuth: unknown,
  order: VerifiedOrderV1,
  intent: VerifiedFillIntentV1,
  options: ProtocolVerificationOptions = {},
): VerifiedFillV1 {
  const fill = canonicalFillBody(rawFill);
  const auth = parseAuth(rawAuth, "auth", true);
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const allowExpired = options.allowExpired ?? false;
  assertOrderReference(order, fill.orderDigest);
  assertOrderValidity(order, auth.issuedAt, now, allowExpired);
  if (fill.intentDigest !== intent.intentDigest) {
    invalid("intentDigest does not match the signed fill intent");
  }
  if (intent.terms.orderDigest !== fill.orderDigest) {
    invalid("fill intent references a different signed order");
  }
  if (
    caipEthAccount(fill.takerEthAccount) !== intent.terms.takerEthAccount ||
    fill.takerQrlAccount !== intent.terms.takerQrlAccount ||
    fill.releaseCommitment !== intent.terms.releaseCommitment
  ) {
    invalid("fill taker terms do not match the signed fill intent");
  }
  if (auth.issuedAt < intent.auth.issuedAt || auth.issuedAt >= intent.auth.expiresAt) {
    invalid("fill issuance falls outside the fill intent validity window");
  }

  const responseWindow = auth.expiresAt - auth.issuedAt;
  if (responseWindow < MIN_FILL_RESPONSE_S || responseWindow > MAX_FILL_RESPONSE_S) {
    invalid("fill respondBy must be 60 to 900 seconds after issuance");
  }
  if (auth.expiresAt > order.auth.expiresAt) {
    invalid("fill respondBy exceeds the order validity window");
  }
  assertInitialAcceptance(auth, now, "fill", allowExpired);
  if (fill.responderTimeout - auth.expiresAt <= MIN_RESPONDER_RUNWAY_AFTER_RESPONSE_S) {
    invalid("responder timeout must be more than 600 seconds after respondBy");
  }

  const initiatorWindow = fill.initiatorTimeout - auth.issuedAt;
  const responderWindow = fill.responderTimeout - auth.issuedAt;
  if (responderWindow <= 0 || initiatorWindow < responderWindow) {
    invalid("fill timeouts must follow issuance");
  }
  if (responderWindow > MAX_RESPONDER_WINDOW_S) {
    invalid("fill responder timeout exceeds the maximum window");
  }
  if (!order.terms.prelocked && initiatorWindow > MAX_INITIATOR_WINDOW_S) {
    invalid("fill initiator timeout exceeds the maximum window");
  }
  if (responderWindow > Math.floor(initiatorWindow / 2)) {
    invalid("initiator timeout window must be at least twice the responder window");
  }

  if (order.terms.prelocked) {
    if (
      fill.hashlock !== order.terms.hashlock ||
      String(fill.initiatorTimeout) !== order.terms.initiatorTimeout
    ) {
      invalid("fill hashlock and initiator timeout must match the signed prelock");
    }
    if (fill.initiatorTimeout - auth.issuedAt < MIN_PRELOCK_RUNWAY_S) {
      invalid("signed prelock must provide at least 9000 seconds of runway");
    }
    if (!allowExpired && fill.initiatorTimeout - now < MIN_PRELOCK_RUNWAY_S) {
      invalid("signed prelock must retain at least 9000 seconds of runway");
    }
  }

  const terms: FillV1Terms = {
    orderDigest: fill.orderDigest,
    orderNonce: order.auth.nonce,
    intentDigest: fill.intentDigest,
    fillNonce: auth.nonce,
    takerEthAccount: caipEthAccount(fill.takerEthAccount),
    takerQrlAccount: fill.takerQrlAccount,
    releaseCommitment: fill.releaseCommitment,
    hashlock: fill.hashlock,
    initiatorTimeout: String(fill.initiatorTimeout),
    responderTimeout: String(fill.responderTimeout),
    issuedAt: String(auth.issuedAt),
    respondBy: String(auth.expiresAt),
    ...ORDER_V1_DEPLOYMENT,
  };
  const payload = buildFillV1Payload(terms, auth.scheme);
  if (!verifyProof(order.terms.makerQrlAccount, auth, payload)) {
    throw new ApiError(401, "maker signature is invalid");
  }

  return {
    fillDigest: fillDigest(terms),
    fill,
    auth,
    terms,
  };
}

export function verifyCancelV1(
  rawCancel: unknown,
  rawAuth: unknown,
  order: VerifiedOrderV1,
  options: ProtocolVerificationOptions = {},
): VerifiedCancelV1 {
  const cancel = canonicalCancelBody(rawCancel);
  const auth = parseAuth(rawAuth, "auth", true);
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const allowExpired = options.allowExpired ?? false;
  assertOrderReference(order, cancel.orderDigest);
  assertOrderValidity(order, auth.issuedAt, now, allowExpired);
  if (auth.expiresAt !== order.auth.expiresAt) {
    invalid("cancel auth expiry must equal the signed order expiry");
  }
  assertInitialAcceptance(auth, now, "cancel", allowExpired);

  const terms: CancelV1Terms = {
    orderDigest: cancel.orderDigest,
    orderNonce: order.auth.nonce,
    cancelNonce: auth.nonce,
    issuedAt: String(auth.issuedAt),
    reasonCode: cancel.reasonCode,
    ...ORDER_V1_DEPLOYMENT,
  };
  const payload = buildCancelV1Payload(terms, auth.scheme);
  if (!verifyProof(order.terms.makerQrlAccount, auth, payload)) {
    throw new ApiError(401, "maker signature is invalid");
  }

  return {
    cancelDigest: cancelDigest(terms),
    cancel,
    auth,
    terms,
  };
}
