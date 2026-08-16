import { shake256 } from "@noble/hashes/sha3.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  isQrlSignedTypedDataResult,
  verifyTypedDataForSigner,
  type QrlTypedDataPayload,
} from "@qrlwallet/connect";
import { cryptoSignVerify } from "@theqrl/mldsa87";
import {
  TypedDataEncoder,
  concat,
  getBytes,
  keccak256,
  toUtf8Bytes,
} from "ethers";
import type { CreateOrderBody, MakerOrderAuthV1, OrderView } from "@/lib/orderbook";

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

export type ProtocolAuthV1 = Omit<
  MakerOrderAuthV1,
  "makerTokenCommitment" | "shareTokenCommitment"
>;

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

export interface FillIntentV1Body {
  orderDigest: string;
  takerEthAccount: string;
  takerQrlAccount: string;
  releaseCommitment: string;
}

export interface FillIntentV1Terms
  extends FillIntentV1Body,
    ProtocolDeploymentTerms {
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

export interface FillV1Terms
  extends Omit<FillV1Body, "initiatorTimeout" | "responderTimeout">,
    ProtocolDeploymentTerms {
  orderNonce: string;
  fillNonce: string;
  initiatorTimeout: string;
  responderTimeout: string;
  issuedAt: string;
  respondBy: string;
  ethChainId: string;
  ethHtlc: string;
  qrlChainId: string;
  qrlHtlc: string;
}

export interface CancelV1Body {
  orderDigest: string;
  reasonCode: number;
}

export interface CancelV1Terms extends CancelV1Body, ProtocolDeploymentTerms {
  orderNonce: string;
  cancelNonce: string;
  issuedAt: string;
  ethChainId: string;
  ethHtlc: string;
  qrlChainId: string;
  qrlHtlc: string;
}

export interface SignedFillIntentV1 {
  intent: FillIntentV1Body;
  auth: ProtocolAuthV1;
}

export interface SignedFillV1 {
  fill: FillV1Body;
  auth: ProtocolAuthV1;
}

export interface SignedCancelV1 {
  cancel: CancelV1Body;
  auth: ProtocolAuthV1;
}

interface SigningRequest {
  method: string;
  params?: unknown[];
}

const CUSTOM_SIGNING_RDNS = new Set([
  "com.qrlwallet.connect",
  "com.qrlwallet.extension",
]);
const OFFICIAL_SIGNING_RDNS = "theqrl.org";
const SIGNATURE_BYTES = 4627;
const PUBLIC_KEY_BYTES = 2592;
const ORDER_LIFETIME_S = 48 * 3600;
const MIN_ORDER_LIFETIME_S = 60;
const FILL_INTENT_LIFETIME_S = 120;
const MIN_FILL_RESPONSE_S = 60;
const MAX_FILL_RESPONSE_S = 15 * 60;
const MIN_RESPONDER_RUNWAY_AFTER_RESPONSE_S = 600;
const MAX_RESPONDER_TIMEOUT_WINDOW_S = 2 * 3600;
const MAX_INITIATOR_TIMEOUT_WINDOW_S = 4 * 3600;
const MIN_PRELOCK_RUNWAY_S = 9_000;
const MIN_ORDER_PRELOCK_RUNWAY_S = 3 * 3600;
const MAX_ORDER_PRELOCK_RUNWAY_S = 72 * 3600;
const MAX_CLOCK_SKEW_S = 5 * 60;
const ZERO_HASHLOCK = `0x${"00".repeat(32)}`;
const ZOND_CONTEXT = new TextEncoder().encode("ZOND");
const QRL_MESSAGE_PREFIX = toUtf8Bytes("\x19QRL Signed Message:\n32");
const ETH_ADDR_INPUT_RE = /^0x[0-9a-fA-F]{40}$/;
const QRL_ADDR_INPUT_RE = /^Q[0-9a-fA-F]{40}$/;
const BYTES32_INPUT_RE = /^0x[0-9a-fA-F]{64}$/;
const ETH_ADDR_RE = /^0x[0-9a-f]{40}$/;
const QRL_ADDR_RE = /^Q[0-9a-f]{40}$/;
const AMOUNT_RE = /^(?:0|[1-9][0-9]{0,29})$/;
const BYTES32_RE = /^0x[0-9a-f]{64}$/;
const SIGNATURE_RE = new RegExp(`^0x[0-9a-f]{${SIGNATURE_BYTES * 2}}$`);
const PUBLIC_KEY_RE = new RegExp(`^0x[0-9a-f]{${PUBLIC_KEY_BYTES * 2}}$`);
const DESCRIPTOR_RE = /^0x[0-9a-f]{6}$/;
const RELEASE_SECRET_RE = /^0x[0-9a-f]{64}$/;
const RELEASE_COMMITMENT_DOMAIN = toUtf8Bytes("QuantaSwap ReleaseV1\0");
const ORDER_ID_DOMAIN = toUtf8Bytes("QuantaSwap OrderV1 id\0");
const MAKER_CAPABILITY_DOMAIN = toUtf8Bytes("QuantaSwap Maker capability V1\0");
const SHARE_CAPABILITY_DOMAIN = toUtf8Bytes("QuantaSwap Share capability V1\0");
export const EMPTY_CAPABILITY_COMMITMENT = `0x${"00".repeat(32)}`;
const CAPABILITY_RE = /^[0-9a-f]{64}$/;

type TypedField = { readonly name: string; readonly type: string };

export function orderSigningSchemeForWallet(rdns: string | null): OrderSigningScheme | null {
  if (rdns === OFFICIAL_SIGNING_RDNS) return "qrl-eip712-v4";
  if (rdns !== null && CUSTOM_SIGNING_RDNS.has(rdns)) return "qrl-sign-typed-v1";
  return null;
}

export function orderSigningLabel(rdns: string | null): string {
  const scheme = orderSigningSchemeForWallet(rdns);
  if (scheme === "qrl-eip712-v4") return "Official QRL wallet · EIP-712 v4";
  if (scheme === "qrl-sign-typed-v1") return "MyQRLWallet · PQ typed data v1";
  return "Connect a compatible QRL wallet";
}

function canonicalEthAddress(value: string, field: string): string {
  if (!ETH_ADDR_INPUT_RE.test(value)) {
    throw new Error(`${field} must be an Ethereum address`);
  }
  return value.toLowerCase();
}

function canonicalQrlAddress(value: string, field: string): string {
  if (!QRL_ADDR_INPUT_RE.test(value)) {
    throw new Error(`${field} must be a QRL address`);
  }
  return `Q${value.slice(1).toLowerCase()}`;
}

function canonicalBytes32(value: string, field: string): string {
  if (!BYTES32_INPUT_RE.test(value)) {
    throw new Error(`${field} must be a 32-byte hex string`);
  }
  return value.toLowerCase();
}

function canonicalAmount(value: string, field: string): string {
  if (!AMOUNT_RE.test(value)) {
    throw new Error(`${field} must be a canonical base-unit amount`);
  }
  return value;
}

function safeUint(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function normalizeOrderBody(body: CreateOrderBody): CreateOrderBody {
  if (body.direction !== "eth->qrl" && body.direction !== "qrl->eth") {
    throw new Error("order.direction is invalid");
  }
  if (body.asset !== "ETH" && body.asset !== "USDC" && body.asset !== "tUSDT") {
    throw new Error("order.asset is invalid");
  }
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
  return {
    direction: body.direction,
    asset: body.asset,
    fromAmount: canonicalAmount(body.fromAmount, "order.fromAmount"),
    toAmount: canonicalAmount(body.toAmount, "order.toAmount"),
    makerEthAccount: canonicalEthAddress(body.makerEthAccount, "order.makerEthAccount"),
    makerQrlAccount: canonicalQrlAddress(body.makerQrlAccount, "order.makerQrlAccount"),
    visibility,
    ...(body.allowedTakerEth === undefined
      ? {}
      : {
          allowedTakerEth: canonicalEthAddress(
            body.allowedTakerEth,
            "order.allowedTakerEth",
          ),
        }),
    ...(body.allowedTakerQrl === undefined
      ? {}
      : {
          allowedTakerQrl: canonicalQrlAddress(
            body.allowedTakerQrl,
            "order.allowedTakerQrl",
          ),
        }),
    ...(body.prelock === undefined
      ? {}
      : {
          prelock: {
            hashlock: canonicalBytes32(
              body.prelock.hashlock,
              "order.prelock.hashlock",
            ),
            initiatorTimeout: safeUint(
              body.prelock.initiatorTimeout,
              "order.prelock.initiatorTimeout",
            ),
          },
        }),
  };
}

function nonceHex(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function capabilityToken(): string {
  for (;;) {
    const value = nonceHex().slice(2);
    if (!/^0+$/.test(value)) return value;
  }
}

export function capabilityCommitment(
  domain: "maker" | "share",
  token: string,
): string {
  if (!CAPABILITY_RE.test(token)) {
    throw new Error("Capability token must be 32 raw bytes as lowercase hex");
  }
  const prefix = domain === "maker" ? MAKER_CAPABILITY_DOMAIN : SHARE_CAPABILITY_DOMAIN;
  return `0x${Array.from(
    sha256(concatBytes(prefix, getBytes(`0x${token}`))),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

export function verifyOrderCapabilities(
  order: Pick<CreateOrderBody, "visibility">,
  auth: Pick<MakerOrderAuthV1, "makerTokenCommitment" | "shareTokenCommitment">,
  makerToken: string,
  shareToken?: string,
): boolean {
  try {
    if (
      !CAPABILITY_RE.test(makerToken) ||
      /^0+$/.test(makerToken) ||
      capabilityCommitment("maker", makerToken) !== auth.makerTokenCommitment
    ) {
      return false;
    }
    if ((order.visibility ?? "public") === "public") {
      return shareToken === undefined && auth.shareTokenCommitment === EMPTY_CAPABILITY_COMMITMENT;
    }
    return (
      shareToken !== undefined &&
      CAPABILITY_RE.test(shareToken) &&
      !/^0+$/.test(shareToken) &&
      capabilityCommitment("share", shareToken) === auth.shareTokenCommitment
    );
  } catch {
    return false;
  }
}

function canonicalWalletHex(raw: unknown, bytes: number, field: string): string {
  if (typeof raw !== "string") throw new Error(`Wallet returned no ${field}`);
  const value = raw.startsWith("0x") ? raw.slice(2) : raw;
  if (value.length !== bytes * 2 || !/^[0-9a-fA-F]+$/.test(value)) {
    throw new Error(`Wallet returned an invalid ${field}`);
  }
  return `0x${value.toLowerCase()}`;
}

function typedDataPayload(
  primaryType: string,
  fields: readonly TypedField[],
  message: Record<string, unknown>,
  scheme: OrderSigningScheme,
): QrlTypedDataPayload {
  return {
    types: {
      [scheme === "qrl-sign-typed-v1" ? "QRLDomain" : "EIP712Domain"]: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "salt", type: "bytes32" },
      ],
      [primaryType]: [...fields],
    },
    primaryType,
    domain: { ...ORDER_V1_DOMAIN },
    message,
  };
}

function semanticDigest(
  primaryType: string,
  fields: readonly TypedField[],
  message: Record<string, unknown>,
): string {
  return TypedDataEncoder.hash(
    ORDER_V1_DOMAIN,
    { [primaryType]: [...fields] },
    message,
  );
}

function ethCaip(account: string): string {
  return `eip155:${ORDER_V1_DEPLOYMENT.ethChainId}:${account}`;
}

function fillIntentTerms(
  intent: FillIntentV1Body,
  auth: Pick<ProtocolAuthV1, "issuedAt" | "expiresAt" | "nonce">,
): FillIntentV1Terms {
  return {
    ...intent,
    requestNonce: auth.nonce,
    takerEthAccount: ethCaip(intent.takerEthAccount),
    issuedAt: String(auth.issuedAt),
    expiresAt: String(auth.expiresAt),
    ...ORDER_V1_DEPLOYMENT,
  };
}

function fillTerms(
  fill: FillV1Body,
  orderAuth: Pick<MakerOrderAuthV1, "nonce">,
  auth: Pick<ProtocolAuthV1, "issuedAt" | "expiresAt" | "nonce">,
): FillV1Terms {
  return {
    ...fill,
    orderNonce: orderAuth.nonce,
    fillNonce: auth.nonce,
    takerEthAccount: ethCaip(fill.takerEthAccount),
    initiatorTimeout: String(fill.initiatorTimeout),
    responderTimeout: String(fill.responderTimeout),
    issuedAt: String(auth.issuedAt),
    respondBy: String(auth.expiresAt),
    ...ORDER_V1_DEPLOYMENT,
  };
}

function cancelTerms(
  cancel: CancelV1Body,
  orderAuth: Pick<MakerOrderAuthV1, "nonce">,
  auth: Pick<ProtocolAuthV1, "issuedAt" | "nonce">,
): CancelV1Terms {
  return {
    ...cancel,
    orderNonce: orderAuth.nonce,
    cancelNonce: auth.nonce,
    issuedAt: String(auth.issuedAt),
    ...ORDER_V1_DEPLOYMENT,
  };
}

export function computeReleaseCommitment(
  orderDigestHex: string,
  requestNonce: string,
  releaseSecret: string,
): string {
  if (
    !BYTES32_RE.test(orderDigestHex) ||
    !BYTES32_RE.test(requestNonce) ||
    !RELEASE_SECRET_RE.test(releaseSecret)
  ) {
    throw new Error("Release commitment inputs must be lowercase bytes32 values");
  }
  return `0x${Array.from(
    sha256(
      concatBytes(
        RELEASE_COMMITMENT_DOMAIN,
        getBytes(orderDigestHex),
        getBytes(requestNonce),
        getBytes(releaseSecret),
      ),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

export function deriveOrderV1Id(makerQrlAccount: string, nonce: string): string {
  if (!QRL_ADDR_RE.test(makerQrlAccount) || !BYTES32_RE.test(nonce)) {
    throw new Error("OrderV1 id inputs must use canonical QRL and bytes32 values");
  }
  return Array.from(
    sha256(
      concatBytes(
        ORDER_ID_DOMAIN,
        getBytes(`0x${makerQrlAccount.slice(1)}`),
        getBytes(nonce),
      ),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function signedOrderTerms(
  order: CreateOrderBody,
  auth: Pick<
    MakerOrderAuthV1,
    | "issuedAt"
    | "expiresAt"
    | "nonce"
    | "makerTokenCommitment"
    | "shareTokenCommitment"
  >,
): SignedOrderTerms {
  return {
    direction: order.direction,
    asset: order.asset,
    fromAmount: order.fromAmount,
    toAmount: order.toAmount,
    makerEthAccount: ethCaip(order.makerEthAccount),
    makerQrlAccount: order.makerQrlAccount,
    visibility: order.visibility ?? "public",
    allowedTakerEth:
      order.allowedTakerEth === undefined ? "" : ethCaip(order.allowedTakerEth),
    allowedTakerQrl: order.allowedTakerQrl ?? "",
    prelocked: order.prelock !== undefined,
    hashlock: order.prelock?.hashlock ?? ZERO_HASHLOCK,
    initiatorTimeout: String(order.prelock?.initiatorTimeout ?? 0),
    issuedAt: String(auth.issuedAt),
    expiresAt: String(auth.expiresAt),
    nonce: auth.nonce,
    makerTokenCommitment: auth.makerTokenCommitment,
    shareTokenCommitment: auth.shareTokenCommitment,
    ...ORDER_V1_DEPLOYMENT,
  };
}

export function buildOrderV1Payload(
  terms: SignedOrderTerms,
  scheme: OrderSigningScheme,
): QrlTypedDataPayload;
export function buildOrderV1Payload(
  order: CreateOrderBody,
  auth: Pick<
    MakerOrderAuthV1,
    | "scheme"
    | "issuedAt"
    | "expiresAt"
    | "nonce"
    | "makerTokenCommitment"
    | "shareTokenCommitment"
  >,
): QrlTypedDataPayload;
export function buildOrderV1Payload(
  orderOrTerms: CreateOrderBody | SignedOrderTerms,
  authOrScheme:
    | Pick<
        MakerOrderAuthV1,
        | "scheme"
        | "issuedAt"
        | "expiresAt"
        | "nonce"
        | "makerTokenCommitment"
        | "shareTokenCommitment"
      >
    | OrderSigningScheme,
): QrlTypedDataPayload {
  const terms =
    typeof authOrScheme === "string"
      ? (orderOrTerms as SignedOrderTerms)
      : signedOrderTerms(orderOrTerms as CreateOrderBody, authOrScheme);
  const scheme = typeof authOrScheme === "string" ? authOrScheme : authOrScheme.scheme;
  return typedDataPayload("OrderV1", ORDER_V1_FIELDS, terms, scheme);
}

export function buildFillIntentV1Payload(
  terms: FillIntentV1Terms,
  scheme: OrderSigningScheme,
): QrlTypedDataPayload;
export function buildFillIntentV1Payload(
  intent: FillIntentV1Body,
  auth: Pick<ProtocolAuthV1, "scheme" | "issuedAt" | "expiresAt" | "nonce">,
): QrlTypedDataPayload;
export function buildFillIntentV1Payload(
  intentOrTerms: FillIntentV1Body | FillIntentV1Terms,
  authOrScheme:
    | Pick<ProtocolAuthV1, "scheme" | "issuedAt" | "expiresAt" | "nonce">
    | OrderSigningScheme,
): QrlTypedDataPayload {
  const terms =
    typeof authOrScheme === "string"
      ? (intentOrTerms as FillIntentV1Terms)
      : fillIntentTerms(intentOrTerms as FillIntentV1Body, authOrScheme);
  const scheme = typeof authOrScheme === "string" ? authOrScheme : authOrScheme.scheme;
  return typedDataPayload(
    "FillIntentV1",
    FILL_INTENT_V1_FIELDS,
    terms,
    scheme,
  );
}

export function buildFillV1Payload(
  terms: FillV1Terms,
  scheme: OrderSigningScheme,
): QrlTypedDataPayload;
export function buildFillV1Payload(
  fill: FillV1Body,
  orderAuth: Pick<MakerOrderAuthV1, "nonce">,
  auth: Pick<ProtocolAuthV1, "scheme" | "issuedAt" | "expiresAt" | "nonce">,
): QrlTypedDataPayload;
export function buildFillV1Payload(
  fillOrTerms: FillV1Body | FillV1Terms,
  orderAuthOrScheme: Pick<MakerOrderAuthV1, "nonce"> | OrderSigningScheme,
  auth?: Pick<ProtocolAuthV1, "scheme" | "issuedAt" | "expiresAt" | "nonce">,
): QrlTypedDataPayload {
  const terms =
    typeof orderAuthOrScheme === "string"
      ? (fillOrTerms as FillV1Terms)
      : fillTerms(fillOrTerms as FillV1Body, orderAuthOrScheme, auth!);
  const scheme =
    typeof orderAuthOrScheme === "string" ? orderAuthOrScheme : auth!.scheme;
  return typedDataPayload(
    "FillV1",
    FILL_V1_FIELDS,
    terms,
    scheme,
  );
}

export function buildCancelV1Payload(
  terms: CancelV1Terms,
  scheme: OrderSigningScheme,
): QrlTypedDataPayload;
export function buildCancelV1Payload(
  cancel: CancelV1Body,
  orderAuth: Pick<MakerOrderAuthV1, "nonce">,
  auth: Pick<ProtocolAuthV1, "scheme" | "issuedAt" | "nonce">,
): QrlTypedDataPayload;
export function buildCancelV1Payload(
  cancelOrTerms: CancelV1Body | CancelV1Terms,
  orderAuthOrScheme: Pick<MakerOrderAuthV1, "nonce"> | OrderSigningScheme,
  auth?: Pick<ProtocolAuthV1, "scheme" | "issuedAt" | "nonce">,
): QrlTypedDataPayload {
  const terms =
    typeof orderAuthOrScheme === "string"
      ? (cancelOrTerms as CancelV1Terms)
      : cancelTerms(cancelOrTerms as CancelV1Body, orderAuthOrScheme, auth!);
  const scheme =
    typeof orderAuthOrScheme === "string" ? orderAuthOrScheme : auth!.scheme;
  return typedDataPayload(
    "CancelV1",
    CANCEL_V1_FIELDS,
    terms,
    scheme,
  );
}

export function orderDigest(terms: SignedOrderTerms): string;
export function orderDigest(
  order: CreateOrderBody,
  auth: Pick<
    MakerOrderAuthV1,
    | "issuedAt"
    | "expiresAt"
    | "nonce"
    | "makerTokenCommitment"
    | "shareTokenCommitment"
  >,
): string;
export function orderDigest(
  orderOrTerms: CreateOrderBody | SignedOrderTerms,
  auth?: Pick<
    MakerOrderAuthV1,
    | "issuedAt"
    | "expiresAt"
    | "nonce"
    | "makerTokenCommitment"
    | "shareTokenCommitment"
  >,
): string {
  const terms =
    auth === undefined
      ? (orderOrTerms as SignedOrderTerms)
      : signedOrderTerms(orderOrTerms as CreateOrderBody, auth);
  return semanticDigest("OrderV1", ORDER_V1_FIELDS, terms);
}

export function intentDigest(terms: FillIntentV1Terms): string;
export function intentDigest(
  intent: FillIntentV1Body,
  auth: Pick<ProtocolAuthV1, "issuedAt" | "expiresAt" | "nonce">,
): string;
export function intentDigest(
  intentOrTerms: FillIntentV1Body | FillIntentV1Terms,
  auth?: Pick<ProtocolAuthV1, "issuedAt" | "expiresAt" | "nonce">,
): string {
  const terms =
    auth === undefined
      ? (intentOrTerms as FillIntentV1Terms)
      : fillIntentTerms(intentOrTerms as FillIntentV1Body, auth);
  return semanticDigest("FillIntentV1", FILL_INTENT_V1_FIELDS, terms);
}

export function fillDigest(terms: FillV1Terms): string;
export function fillDigest(
  fill: FillV1Body,
  orderAuth: Pick<MakerOrderAuthV1, "nonce">,
  auth: Pick<ProtocolAuthV1, "issuedAt" | "expiresAt" | "nonce">,
): string;
export function fillDigest(
  fillOrTerms: FillV1Body | FillV1Terms,
  orderAuth?: Pick<MakerOrderAuthV1, "nonce">,
  auth?: Pick<ProtocolAuthV1, "issuedAt" | "expiresAt" | "nonce">,
): string {
  const terms =
    orderAuth === undefined || auth === undefined
      ? (fillOrTerms as FillV1Terms)
      : fillTerms(fillOrTerms as FillV1Body, orderAuth, auth);
  return semanticDigest("FillV1", FILL_V1_FIELDS, terms);
}

export function cancelDigest(terms: CancelV1Terms): string;
export function cancelDigest(
  cancel: CancelV1Body,
  orderAuth: Pick<MakerOrderAuthV1, "nonce">,
  auth: Pick<ProtocolAuthV1, "issuedAt" | "nonce">,
): string;
export function cancelDigest(
  cancelOrTerms: CancelV1Body | CancelV1Terms,
  orderAuth?: Pick<MakerOrderAuthV1, "nonce">,
  auth?: Pick<ProtocolAuthV1, "issuedAt" | "nonce">,
): string {
  const terms =
    orderAuth === undefined || auth === undefined
      ? (cancelOrTerms as CancelV1Terms)
      : cancelTerms(cancelOrTerms as CancelV1Body, orderAuth, auth);
  return semanticDigest("CancelV1", CANCEL_V1_FIELDS, terms);
}

export async function signOrderV1({
  body,
  walletRdns,
  request,
  now = Math.floor(Date.now() / 1000),
}: {
  body: CreateOrderBody;
  walletRdns: string | null;
  request: (args: SigningRequest) => Promise<unknown>;
  now?: number;
}): Promise<{
  order: CreateOrderBody;
  auth: MakerOrderAuthV1;
  makerToken: string;
  shareToken?: string;
}> {
  const scheme = orderSigningSchemeForWallet(walletRdns);
  if (scheme === null) {
    throw new Error(
      "This QRL wallet cannot sign portable orders. Use MyQRLWallet or the official QRL Web3 Wallet.",
    );
  }
  const requestedSigner = body.makerQrlAccount;
  const order = normalizeOrderBody(body);
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error("Order issuance must be a non-negative safe integer");
  }
  if (
    order.prelock !== undefined &&
    (order.prelock.initiatorTimeout - now < MIN_ORDER_PRELOCK_RUNWAY_S ||
      order.prelock.initiatorTimeout - now > MAX_ORDER_PRELOCK_RUNWAY_S)
  ) {
    throw new Error("A signed prelock must provide 3 to 72 hours of runway");
  }
  const expiresAt = Math.min(
    now + ORDER_LIFETIME_S,
    order.prelock?.initiatorTimeout ?? Number.POSITIVE_INFINITY,
  );
  if (
    !Number.isSafeInteger(expiresAt) ||
    expiresAt - now < MIN_ORDER_LIFETIME_S
  ) {
    throw new Error("A signed order must provide at least 60 seconds of safe validity");
  }
  const makerToken = capabilityToken();
  const shareToken = order.visibility === "private" ? capabilityToken() : undefined;
  const unsignedAuth = {
    scheme,
    issuedAt: now,
    expiresAt,
    nonce: nonceHex(),
    makerTokenCommitment: capabilityCommitment("maker", makerToken),
    shareTokenCommitment:
      shareToken === undefined
        ? EMPTY_CAPABILITY_COMMITMENT
        : capabilityCommitment("share", shareToken),
  } as const;
  const payload = buildOrderV1Payload(order, unsignedAuth);

  if (scheme === "qrl-sign-typed-v1") {
    const result = await request({
      method: "qrl_signTypedData",
      params: [requestedSigner, payload],
    });
    if (!isQrlSignedTypedDataResult(result) || result.descriptor === undefined) {
      throw new Error("Wallet returned an unsupported typed-data signature");
    }
    if (
      !verifyTypedDataForSigner({
        expectedSigner: order.makerQrlAccount,
        descriptor: result.descriptor,
        signature: result.signature,
        publicKey: result.publicKey,
        payload,
      })
    ) {
      throw new Error("Wallet returned a signature that does not match this order");
    }
    return {
      order,
      makerToken,
      ...(shareToken === undefined ? {} : { shareToken }),
      auth: {
        version: "1",
        ...unsignedAuth,
        signature: result.signature.toLowerCase(),
        publicKey: result.publicKey.toLowerCase(),
        descriptor: result.descriptor.toLowerCase(),
      },
    };
  }

  const result = await request({
    method: "qrl_signTypedData_v4",
    params: [requestedSigner, payload],
  });
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw new Error("Official QRL wallet returned an invalid typed-data signature");
  }
  const response = result as Record<string, unknown>;
  const auth: MakerOrderAuthV1 = {
    version: "1",
    ...unsignedAuth,
    signature: canonicalWalletHex(
      response["signature"],
      SIGNATURE_BYTES,
      "signature",
    ),
    publicKey: canonicalWalletHex(
      response["publicKey"],
      PUBLIC_KEY_BYTES,
      "public key",
    ),
    descriptor: "0x010000",
  };
  if (
    !officialProofIsValid(
      order.makerQrlAccount,
      auth,
      payload,
      "OrderV1",
      ORDER_V1_FIELDS,
    )
  ) {
    throw new Error("Official QRL wallet returned a signature that does not match this order");
  }
  return {
    order,
    makerToken,
    ...(shareToken === undefined ? {} : { shareToken }),
    auth,
  };
}

async function signProtocolAuth({
  signer,
  walletRdns,
  request,
  issuedAt,
  expiresAt,
  nonce,
  payloadFor,
  primaryType,
  fields,
}: {
  signer: string;
  walletRdns: string | null;
  request: (args: SigningRequest) => Promise<unknown>;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
  payloadFor: (
    auth: Pick<ProtocolAuthV1, "scheme" | "issuedAt" | "expiresAt" | "nonce">,
  ) => QrlTypedDataPayload;
  primaryType: string;
  fields: readonly TypedField[];
}): Promise<ProtocolAuthV1> {
  const scheme = orderSigningSchemeForWallet(walletRdns);
  if (scheme === null) {
    throw new Error(
      "This QRL wallet cannot sign portable order-book messages. Use MyQRLWallet or the official QRL Web3 Wallet.",
    );
  }
  const unsignedAuth = { scheme, issuedAt, expiresAt, nonce } as const;
  const payload = payloadFor(unsignedAuth);
  let auth: ProtocolAuthV1;

  if (scheme === "qrl-sign-typed-v1") {
    const result = await request({ method: "qrl_signTypedData", params: [signer, payload] });
    if (
      !isQrlSignedTypedDataResult(result) ||
      result.descriptor === undefined ||
      !verifyTypedDataForSigner({
        expectedSigner: signer,
        descriptor: result.descriptor,
        signature: result.signature,
        publicKey: result.publicKey,
        payload,
      })
    ) {
      throw new Error("Wallet returned a signature that does not match this message");
    }
    auth = {
      version: "1",
      ...unsignedAuth,
      signature: result.signature.toLowerCase(),
      publicKey: result.publicKey.toLowerCase(),
      descriptor: result.descriptor.toLowerCase(),
    };
  } else {
    const result = await request({
      method: "qrl_signTypedData_v4",
      params: [signer, payload],
    });
    if (typeof result !== "object" || result === null || Array.isArray(result)) {
      throw new Error("Official QRL wallet returned an invalid typed-data signature");
    }
    const response = result as Record<string, unknown>;
    auth = {
      version: "1",
      ...unsignedAuth,
      signature: canonicalWalletHex(response["signature"], SIGNATURE_BYTES, "signature"),
      publicKey: canonicalWalletHex(response["publicKey"], PUBLIC_KEY_BYTES, "public key"),
      descriptor: "0x010000",
    };
    if (!officialProofIsValid(signer, auth, payload, primaryType, fields)) {
      throw new Error("Official QRL wallet returned a signature that does not match this message");
    }
  }

  return auth;
}

export async function signFillIntentV1({
  body,
  order,
  releaseSecret,
  walletRdns,
  request,
  now = Math.floor(Date.now() / 1000),
  expiresAt = now + FILL_INTENT_LIFETIME_S,
}: {
  body: Omit<FillIntentV1Body, "releaseCommitment">;
  order: OrderView;
  releaseSecret: string;
  walletRdns: string | null;
  request: (args: SigningRequest) => Promise<unknown>;
  now?: number;
  expiresAt?: number;
}): Promise<{ intent: FillIntentV1Body; auth: ProtocolAuthV1 }> {
  if (
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= now ||
    expiresAt - now > FILL_INTENT_LIFETIME_S
  ) {
    throw new Error("Fill requests must expire within 120 seconds");
  }
  const orderAuth = order.makerAuth;
  if (orderAuth !== undefined && now < orderAuth.issuedAt) {
    throw new Error("This order is not valid yet");
  }
  const expectedOrderDigest = verifiedOrderDigest(order, now, false);
  const canonicalOrderDigest = canonicalBytes32(body.orderDigest, "intent.orderDigest");
  if (
    orderAuth === undefined ||
    expectedOrderDigest === null ||
    canonicalOrderDigest !== expectedOrderDigest
  ) {
    throw new Error("Fill request does not match a valid portable order");
  }
  const boundedExpiresAt = Math.min(expiresAt, orderAuth.expiresAt);
  if (boundedExpiresAt <= now) {
    throw new Error("This order has already expired");
  }
  const requestNonce = nonceHex();
  const intent: FillIntentV1Body = {
    orderDigest: canonicalOrderDigest,
    takerEthAccount: canonicalEthAddress(
      body.takerEthAccount,
      "intent.takerEthAccount",
    ),
    takerQrlAccount: canonicalQrlAddress(
      body.takerQrlAccount,
      "intent.takerQrlAccount",
    ),
    releaseCommitment: computeReleaseCommitment(
      canonicalOrderDigest,
      requestNonce,
      canonicalBytes32(releaseSecret, "releaseSecret"),
    ),
  };
  const auth = await signProtocolAuth({
    signer: intent.takerQrlAccount,
    walletRdns,
    request,
    issuedAt: now,
    expiresAt: boundedExpiresAt,
    nonce: requestNonce,
    payloadFor: (unsigned) => buildFillIntentV1Payload(intent, unsigned),
    primaryType: "FillIntentV1",
    fields: FILL_INTENT_V1_FIELDS,
  });
  return { intent, auth };
}

export async function signFillV1({
  body,
  order,
  walletRdns,
  request,
  respondBy,
  now = Math.floor(Date.now() / 1000),
}: {
  body: FillV1Body;
  order: Pick<OrderView, "makerQrlAccount" | "makerAuth" | "prelocked">;
  walletRdns: string | null;
  request: (args: SigningRequest) => Promise<unknown>;
  respondBy: number;
  now?: number;
}): Promise<{ fill: FillV1Body; auth: ProtocolAuthV1 }> {
  const orderAuth = order.makerAuth;
  if (orderAuth === undefined) throw new Error("This order has no portable maker proof");
  if (
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(respondBy) ||
    respondBy - now < MIN_FILL_RESPONSE_S ||
    respondBy - now > MAX_FILL_RESPONSE_S ||
    respondBy > orderAuth.expiresAt
  ) {
    throw new Error("Fill responses must allow 60 to 900 seconds and end before the order expires");
  }
  const fill: FillV1Body = {
    orderDigest: canonicalBytes32(body.orderDigest, "fill.orderDigest"),
    intentDigest: canonicalBytes32(body.intentDigest, "fill.intentDigest"),
    takerEthAccount: canonicalEthAddress(body.takerEthAccount, "fill.takerEthAccount"),
    takerQrlAccount: canonicalQrlAddress(body.takerQrlAccount, "fill.takerQrlAccount"),
    releaseCommitment: canonicalBytes32(
      body.releaseCommitment,
      "fill.releaseCommitment",
    ),
    hashlock: canonicalBytes32(body.hashlock, "fill.hashlock"),
    initiatorTimeout: safeUint(body.initiatorTimeout, "fill.initiatorTimeout"),
    responderTimeout: safeUint(body.responderTimeout, "fill.responderTimeout"),
  };
  if (fill.hashlock === ZERO_HASHLOCK) throw new Error("fill.hashlock cannot be zero");
  if (fill.responderTimeout - now > MAX_RESPONDER_TIMEOUT_WINDOW_S) {
    throw new Error("Fill responder timeout cannot exceed 2 hours after issuance");
  }
  if (
    order.prelocked !== true &&
    fill.initiatorTimeout - now > MAX_INITIATOR_TIMEOUT_WINDOW_S
  ) {
    throw new Error("Fill initiator timeout cannot exceed 4 hours after issuance");
  }
  const auth = await signProtocolAuth({
    signer: order.makerQrlAccount,
    walletRdns,
    request,
    issuedAt: now,
    expiresAt: respondBy,
    nonce: nonceHex(),
    payloadFor: (unsigned) => buildFillV1Payload(fill, orderAuth, unsigned),
    primaryType: "FillV1",
    fields: FILL_V1_FIELDS,
  });
  return { fill, auth };
}

export async function signCancelV1({
  body,
  order,
  walletRdns,
  request,
  now = Math.floor(Date.now() / 1000),
}: {
  body: CancelV1Body;
  order: Pick<OrderView, "makerQrlAccount" | "makerAuth">;
  walletRdns: string | null;
  request: (args: SigningRequest) => Promise<unknown>;
  now?: number;
}): Promise<{ cancel: CancelV1Body; auth: ProtocolAuthV1 }> {
  const orderAuth = order.makerAuth;
  if (orderAuth === undefined) throw new Error("This order has no portable maker proof");
  if (!Number.isSafeInteger(now) || now >= orderAuth.expiresAt) {
    throw new Error("This order has already expired");
  }
  const cancel: CancelV1Body = {
    orderDigest: canonicalBytes32(body.orderDigest, "cancel.orderDigest"),
    reasonCode: safeUint(body.reasonCode, "cancel.reasonCode"),
  };
  if (cancel.reasonCode > 255) throw new Error("cancel.reasonCode must fit uint8");
  const auth = await signProtocolAuth({
    signer: order.makerQrlAccount,
    walletRdns,
    request,
    issuedAt: now,
    expiresAt: orderAuth.expiresAt,
    nonce: nonceHex(),
    payloadFor: (unsigned) => buildCancelV1Payload(cancel, orderAuth, unsigned),
    primaryType: "CancelV1",
    fields: CANCEL_V1_FIELDS,
  });
  return { cancel, auth };
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

function officialDigest(
  payload: QrlTypedDataPayload,
  primaryType: string,
  fields: readonly TypedField[],
): Uint8Array {
  const eip712 = TypedDataEncoder.hash(
    payload.domain,
    { [primaryType]: [...fields] },
    payload.message,
  );
  return getBytes(keccak256(concat([QRL_MESSAGE_PREFIX, getBytes(eip712)])));
}

function officialProofIsValid(
  signer: string,
  auth: ProtocolAuthV1,
  payload: QrlTypedDataPayload,
  primaryType: string,
  fields: readonly TypedField[],
): boolean {
  if (auth.descriptor !== "0x010000") return false;
  const descriptor = getBytes(auth.descriptor);
  const publicKey = getBytes(auth.publicKey);
  const address = shake256(concatBytes(descriptor, publicKey), { dkLen: 20 });
  const derived = `Q${Array.from(address, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  if (derived !== signer) return false;
  return cryptoSignVerify(
    getBytes(auth.signature),
    officialDigest(payload, primaryType, fields),
    publicKey,
    ZOND_CONTEXT,
  );
}

function protocolProofIsValid(
  signer: string,
  auth: ProtocolAuthV1,
  payload: QrlTypedDataPayload,
  primaryType: string,
  fields: readonly TypedField[],
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
  return officialProofIsValid(signer, auth, payload, primaryType, fields);
}

/** Independently authenticate an order returned by a book. This is run
 *  before take confirmation; the server's claim that it verified a proof
 *  is not itself a trust boundary. */
export function verifyOrderV1Auth(
  order: OrderView,
  now = Math.floor(Date.now() / 1000),
  allowExpired = false,
): boolean {
  try {
    const auth = order.makerAuth;
    if (
      auth === undefined ||
      typeof auth !== "object" ||
      auth === null ||
      Array.isArray(auth) ||
      !hasExactKeys(auth, [
        "version",
        "scheme",
        "issuedAt",
        "expiresAt",
        "nonce",
        "makerTokenCommitment",
        "shareTokenCommitment",
        "signature",
        "publicKey",
        "descriptor",
      ]) ||
      auth.version !== "1" ||
      (auth.scheme !== "qrl-sign-typed-v1" && auth.scheme !== "qrl-eip712-v4") ||
      !Number.isSafeInteger(auth.issuedAt) ||
      !Number.isSafeInteger(auth.expiresAt) ||
      auth.issuedAt < 0 ||
      auth.expiresAt <= auth.issuedAt ||
      auth.expiresAt - auth.issuedAt > ORDER_LIFETIME_S ||
      auth.issuedAt > now + MAX_CLOCK_SKEW_S ||
      (!allowExpired && auth.expiresAt <= now) ||
      !BYTES32_RE.test(auth.nonce) ||
      !BYTES32_RE.test(auth.makerTokenCommitment) ||
      auth.makerTokenCommitment === EMPTY_CAPABILITY_COMMITMENT ||
      !BYTES32_RE.test(auth.shareTokenCommitment) ||
      order.id !== deriveOrderV1Id(order.makerQrlAccount, auth.nonce) ||
      !SIGNATURE_RE.test(auth.signature) ||
      !PUBLIC_KEY_RE.test(auth.publicKey) ||
      !DESCRIPTOR_RE.test(auth.descriptor) ||
      (order.direction !== "eth->qrl" && order.direction !== "qrl->eth") ||
      (order.asset !== "ETH" && order.asset !== "USDC" && order.asset !== "tUSDT") ||
      !AMOUNT_RE.test(order.fromAmount) ||
      !AMOUNT_RE.test(order.toAmount) ||
      !ETH_ADDR_RE.test(order.makerEthAccount) ||
      !QRL_ADDR_RE.test(order.makerQrlAccount) ||
      (order.visibility !== "public" && order.visibility !== "private")
    ) {
      return false;
    }
    if (
      (order.visibility === "private") !==
      (auth.shareTokenCommitment !== EMPTY_CAPABILITY_COMMITMENT)
    ) {
      return false;
    }
    if (
      order.allowedTakerEth !== undefined &&
      !ETH_ADDR_RE.test(order.allowedTakerEth)
    ) {
      return false;
    }
    if (
      order.allowedTakerQrl !== undefined &&
      !QRL_ADDR_RE.test(order.allowedTakerQrl)
    ) {
      return false;
    }
    if (
      order.visibility === "public" &&
      (order.allowedTakerEth !== undefined || order.allowedTakerQrl !== undefined)
    ) {
      return false;
    }

    const body: CreateOrderBody = {
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
    };
    if (order.prelocked === true) {
      if (
        typeof order.hashlock !== "string" ||
        !BYTES32_RE.test(order.hashlock) ||
        typeof order.initiatorTimeout !== "number" ||
        !Number.isSafeInteger(order.initiatorTimeout)
      ) {
        return false;
      }
      body.prelock = {
        hashlock: order.hashlock,
        initiatorTimeout: order.initiatorTimeout,
      };
      if (
        order.initiatorTimeout - auth.issuedAt < MIN_ORDER_PRELOCK_RUNWAY_S ||
        order.initiatorTimeout - auth.issuedAt > MAX_ORDER_PRELOCK_RUNWAY_S ||
        auth.expiresAt > order.initiatorTimeout
      ) {
        return false;
      }
    }

    const payload = buildOrderV1Payload(body, auth);
    if (auth.scheme === "qrl-sign-typed-v1") {
      return verifyTypedDataForSigner({
        expectedSigner: order.makerQrlAccount,
        descriptor: auth.descriptor,
        signature: auth.signature,
        publicKey: auth.publicKey,
        payload,
      });
    }
    return officialProofIsValid(
      order.makerQrlAccount,
      auth,
      payload,
      "OrderV1",
      ORDER_V1_FIELDS,
    );
  } catch {
    return false;
  }
}

function authShapeIsValid(
  auth: ProtocolAuthV1,
  now: number,
  options: { minLifetime: number; maxLifetime: number; allowExpired?: boolean },
): boolean {
  return (
    hasExactKeys(auth, [
      "version",
      "scheme",
      "issuedAt",
      "expiresAt",
      "nonce",
      "signature",
      "publicKey",
      "descriptor",
    ]) &&
    auth.version === "1" &&
    (auth.scheme === "qrl-sign-typed-v1" || auth.scheme === "qrl-eip712-v4") &&
    Number.isSafeInteger(auth.issuedAt) &&
    Number.isSafeInteger(auth.expiresAt) &&
    auth.issuedAt >= 0 &&
    auth.expiresAt - auth.issuedAt >= options.minLifetime &&
    auth.expiresAt - auth.issuedAt <= options.maxLifetime &&
    auth.issuedAt <= now + MAX_CLOCK_SKEW_S &&
    (options.allowExpired === true || auth.expiresAt > now) &&
    BYTES32_RE.test(auth.nonce) &&
    SIGNATURE_RE.test(auth.signature) &&
    PUBLIC_KEY_RE.test(auth.publicKey) &&
    DESCRIPTOR_RE.test(auth.descriptor) &&
    (auth.scheme !== "qrl-eip712-v4" || auth.descriptor === "0x010000")
  );
}

function hasExactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

function orderBodyFromView(order: OrderView): CreateOrderBody {
  const body: CreateOrderBody = {
    direction: order.direction,
    asset: order.asset ?? "ETH",
    fromAmount: order.fromAmount,
    toAmount: order.toAmount,
    makerEthAccount: order.makerEthAccount,
    makerQrlAccount: order.makerQrlAccount,
    visibility: order.visibility ?? "public",
    ...(order.allowedTakerEth === undefined
      ? {}
      : { allowedTakerEth: order.allowedTakerEth }),
    ...(order.allowedTakerQrl === undefined
      ? {}
      : { allowedTakerQrl: order.allowedTakerQrl }),
  };
  if (order.prelocked === true) {
    body.prelock = {
      hashlock: order.hashlock as string,
      initiatorTimeout: order.initiatorTimeout as number,
    };
  }
  return body;
}

function verifiedOrderDigest(
  order: OrderView,
  now: number,
  allowExpired: boolean,
): string | null {
  const auth = order.makerAuth;
  if (auth === undefined) return null;
  if (!verifyOrderV1Auth(order, now, allowExpired)) return null;
  return orderDigest(orderBodyFromView(order), auth);
}

type ProtocolVerificationOptions = number | { now?: number; allowExpired?: boolean };

function protocolVerificationOptions(options: ProtocolVerificationOptions): {
  now: number;
  allowExpired: boolean;
} {
  if (typeof options === "number") return { now: options, allowExpired: false };
  return {
    now: options.now ?? Math.floor(Date.now() / 1000),
    allowExpired: options.allowExpired ?? false,
  };
}

function fillIntentBodyIsCanonical(intent: FillIntentV1Body): boolean {
  return (
    hasExactKeys(intent, [
      "orderDigest",
      "takerEthAccount",
      "takerQrlAccount",
      "releaseCommitment",
    ]) &&
    BYTES32_RE.test(intent.orderDigest) &&
    ETH_ADDR_RE.test(intent.takerEthAccount) &&
    QRL_ADDR_RE.test(intent.takerQrlAccount) &&
    BYTES32_RE.test(intent.releaseCommitment)
  );
}

function fillBodyIsCanonical(fill: FillV1Body): boolean {
  return (
    hasExactKeys(fill, [
      "orderDigest",
      "intentDigest",
      "takerEthAccount",
      "takerQrlAccount",
      "releaseCommitment",
      "hashlock",
      "initiatorTimeout",
      "responderTimeout",
    ]) &&
    BYTES32_RE.test(fill.orderDigest) &&
    BYTES32_RE.test(fill.intentDigest) &&
    ETH_ADDR_RE.test(fill.takerEthAccount) &&
    QRL_ADDR_RE.test(fill.takerQrlAccount) &&
    BYTES32_RE.test(fill.releaseCommitment) &&
    BYTES32_RE.test(fill.hashlock) &&
    fill.hashlock !== ZERO_HASHLOCK &&
    Number.isSafeInteger(fill.initiatorTimeout) &&
    Number.isSafeInteger(fill.responderTimeout) &&
    fill.initiatorTimeout >= 0 &&
    fill.responderTimeout >= 0
  );
}

function privateTakerMatches(order: OrderView, intent: FillIntentV1Body): boolean {
  return (
    (order.allowedTakerEth === undefined ||
      order.allowedTakerEth === intent.takerEthAccount) &&
    (order.allowedTakerQrl === undefined ||
      order.allowedTakerQrl === intent.takerQrlAccount)
  );
}

export function verifyFillIntentV1(
  intent: FillIntentV1Body,
  auth: ProtocolAuthV1,
  order: OrderView,
  options: ProtocolVerificationOptions = {},
): boolean {
  try {
    const { now, allowExpired } = protocolVerificationOptions(options);
    const expectedOrderDigest = verifiedOrderDigest(order, now, allowExpired);
    const orderAuth = order.makerAuth;
    if (
      expectedOrderDigest === null ||
      orderAuth === undefined ||
      !fillIntentBodyIsCanonical(intent) ||
      !authShapeIsValid(auth, now, {
        minLifetime: 1,
        maxLifetime: FILL_INTENT_LIFETIME_S,
        allowExpired,
      }) ||
      intent.orderDigest !== expectedOrderDigest ||
      auth.issuedAt < orderAuth.issuedAt ||
      auth.expiresAt > orderAuth.expiresAt ||
      !privateTakerMatches(order, intent)
    ) {
      return false;
    }
    const payload = buildFillIntentV1Payload(intent, auth);
    return protocolProofIsValid(
      intent.takerQrlAccount,
      auth,
      payload,
      "FillIntentV1",
      FILL_INTENT_V1_FIELDS,
    );
  } catch {
    return false;
  }
}

export function verifyFillV1(
  fill: FillV1Body,
  auth: ProtocolAuthV1,
  order: OrderView,
  signedIntent: SignedFillIntentV1,
  options: ProtocolVerificationOptions = {},
): boolean {
  try {
    const { now, allowExpired } = protocolVerificationOptions(options);
    const orderAuth = order.makerAuth;
    const expectedOrderDigest = verifiedOrderDigest(order, now, allowExpired);
    if (
      orderAuth === undefined ||
      expectedOrderDigest === null ||
      !verifyFillIntentV1(signedIntent.intent, signedIntent.auth, order, {
        now,
        allowExpired,
      }) ||
      !fillBodyIsCanonical(fill) ||
      !authShapeIsValid(auth, now, {
        minLifetime: MIN_FILL_RESPONSE_S,
        maxLifetime: MAX_FILL_RESPONSE_S,
        allowExpired,
      }) ||
      fill.orderDigest !== expectedOrderDigest ||
      fill.intentDigest !== intentDigest(signedIntent.intent, signedIntent.auth) ||
      fill.takerEthAccount !== signedIntent.intent.takerEthAccount ||
      fill.takerQrlAccount !== signedIntent.intent.takerQrlAccount ||
      fill.releaseCommitment !== signedIntent.intent.releaseCommitment ||
      auth.expiresAt > orderAuth.expiresAt ||
      auth.issuedAt < signedIntent.auth.issuedAt ||
      auth.issuedAt >= signedIntent.auth.expiresAt ||
      fill.responderTimeout - auth.expiresAt <=
        MIN_RESPONDER_RUNWAY_AFTER_RESPONSE_S ||
      fill.responderTimeout - auth.issuedAt <= 0 ||
      fill.responderTimeout - auth.issuedAt > MAX_RESPONDER_TIMEOUT_WINDOW_S ||
      fill.initiatorTimeout - auth.issuedAt <
        fill.responderTimeout - auth.issuedAt ||
      (order.prelocked !== true &&
        fill.initiatorTimeout - auth.issuedAt > MAX_INITIATOR_TIMEOUT_WINDOW_S) ||
      fill.responderTimeout - auth.issuedAt >
        Math.floor((fill.initiatorTimeout - auth.issuedAt) / 2) ||
      (order.prelocked === true &&
        (fill.hashlock !== order.hashlock ||
          fill.initiatorTimeout !== order.initiatorTimeout ||
          fill.initiatorTimeout - auth.issuedAt < MIN_PRELOCK_RUNWAY_S ||
          (!allowExpired && fill.initiatorTimeout - now < MIN_PRELOCK_RUNWAY_S)))
    ) {
      return false;
    }
    const payload = buildFillV1Payload(fill, orderAuth, auth);
    return protocolProofIsValid(
      order.makerQrlAccount,
      auth,
      payload,
      "FillV1",
      FILL_V1_FIELDS,
    );
  } catch {
    return false;
  }
}

export function verifyCancelV1(
  cancel: CancelV1Body,
  auth: ProtocolAuthV1,
  order: OrderView,
  options: ProtocolVerificationOptions = {},
): boolean {
  try {
    const { now, allowExpired } = protocolVerificationOptions(options);
    const orderAuth = order.makerAuth;
    const expectedOrderDigest = verifiedOrderDigest(order, now, allowExpired);
    if (
      orderAuth === undefined ||
      expectedOrderDigest === null ||
      !hasExactKeys(cancel, ["orderDigest", "reasonCode"]) ||
      !BYTES32_RE.test(cancel.orderDigest) ||
      !Number.isSafeInteger(cancel.reasonCode) ||
      cancel.reasonCode < 0 ||
      cancel.reasonCode > 255 ||
      !authShapeIsValid(auth, now, {
        minLifetime: 1,
        maxLifetime: ORDER_LIFETIME_S,
        allowExpired,
      }) ||
      cancel.orderDigest !== expectedOrderDigest ||
      auth.issuedAt < orderAuth.issuedAt ||
      auth.issuedAt > orderAuth.expiresAt ||
      auth.expiresAt !== orderAuth.expiresAt
    ) {
      return false;
    }
    const payload = buildCancelV1Payload(cancel, orderAuth, auth);
    return protocolProofIsValid(
      order.makerQrlAccount,
      auth,
      payload,
      "CancelV1",
      CANCEL_V1_FIELDS,
    );
  } catch {
    return false;
  }
}

export const verifyFillIntentV1Auth = verifyFillIntentV1;
export const verifyFillV1Auth = verifyFillV1;
export const verifyCancelV1Auth = verifyCancelV1;
