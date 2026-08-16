// Portable maker authorization for OrderV1. The order book reconstructs the
// payload from the submitted economic terms and verifies the ML-DSA-87 proof;
// it never accepts an arbitrary wallet-supplied payload as authoritative.

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

export interface SignedOrderBaseTerms extends Record<string, unknown> {
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
  ethChainId: string;
  ethHtlc: string;
  qrlChainId: string;
  qrlHtlc: string;
}

export interface SignedOrderTerms extends SignedOrderBaseTerms {
  issuedAt: string;
  expiresAt: string;
  nonce: string;
}

export interface VerifiedOrderV1 {
  orderId: string;
  order: Record<string, unknown>;
  auth: MakerOrderAuthV1;
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
const MAX_CLOCK_SKEW_S = 5 * 60;
const MIN_REMAINING_LIFETIME_S = 60;
const ZOND_CONTEXT = new TextEncoder().encode("ZOND");
const QRL_MESSAGE_PREFIX = new TextEncoder().encode("\x19QRL Signed Message:\n32");
const OFFICIAL_DESCRIPTOR = "0x010000";

function invalid(message: string): never {
  throw new ApiError(400, message);
}

function objectValue(raw: unknown, field: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    invalid(`${field} must be an object`);
  }
  return raw as Record<string, unknown>;
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
  const body = objectValue(raw, "order");
  const direction = body["direction"];
  if (direction !== "eth->qrl" && direction !== "qrl->eth") {
    invalid("order.direction is invalid");
  }
  const asset = body["asset"];
  if (typeof asset !== "string" || !isKnownAsset(asset)) invalid("order.asset is invalid");
  const fromAmount = exactString(body["fromAmount"], "order.fromAmount", AMOUNT_RE);
  const toAmount = exactString(body["toAmount"], "order.toAmount", AMOUNT_RE);
  const makerEthAccount = exactString(
    body["makerEthAccount"],
    "order.makerEthAccount",
    ETH_ADDR_RE,
  );
  const makerQrlAccount = exactString(
    body["makerQrlAccount"],
    "order.makerQrlAccount",
    QRL_ADDR_RE,
  );
  const visibility = body["visibility"];
  if (visibility !== "public" && visibility !== "private") {
    invalid("order.visibility is invalid");
  }

  let allowedTakerEth = "";
  let allowedTakerQrl = "";
  if (visibility === "private") {
    if (body["allowedTakerEth"] !== undefined) {
      allowedTakerEth = exactString(
        body["allowedTakerEth"],
        "order.allowedTakerEth",
        ETH_ADDR_RE,
      );
    }
    if (body["allowedTakerQrl"] !== undefined) {
      allowedTakerQrl = exactString(
        body["allowedTakerQrl"],
        "order.allowedTakerQrl",
        QRL_ADDR_RE,
      );
    }
  } else if (body["allowedTakerEth"] !== undefined || body["allowedTakerQrl"] !== undefined) {
    invalid("public signed orders cannot restrict the taker");
  }

  let prelocked = false;
  let hashlock = EMPTY_HASHLOCK;
  let initiatorTimeout = "0";
  if (body["prelock"] !== undefined) {
    const prelock = objectValue(body["prelock"], "order.prelock");
    prelocked = true;
    hashlock = exactString(prelock["hashlock"], "order.prelock.hashlock", HASHLOCK_RE);
    initiatorTimeout = String(
      exactInteger(prelock["initiatorTimeout"], "order.prelock.initiatorTimeout"),
    );
  }

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

function parseAuth(raw: unknown): MakerOrderAuthV1 {
  const auth = objectValue(raw, "auth");
  if (auth["version"] !== "1") invalid("auth.version must be 1");
  const scheme = auth["scheme"];
  if (scheme !== "qrl-sign-typed-v1" && scheme !== "qrl-eip712-v4") {
    invalid("auth.scheme is unsupported");
  }
  const descriptor = exactString(auth["descriptor"], "auth.descriptor", DESCRIPTOR_RE);
  if (scheme === "qrl-eip712-v4" && descriptor !== OFFICIAL_DESCRIPTOR) {
    invalid("official-wallet orders require descriptor 0x010000");
  }
  return {
    version: "1",
    scheme,
    issuedAt: exactInteger(auth["issuedAt"], "auth.issuedAt"),
    expiresAt: exactInteger(auth["expiresAt"], "auth.expiresAt"),
    nonce: exactString(auth["nonce"], "auth.nonce", BYTES32_RE),
    signature: exactString(auth["signature"], "auth.signature", SIGNATURE_RE),
    publicKey: exactString(auth["publicKey"], "auth.publicKey", PUBLIC_KEY_RE),
    descriptor,
  };
}

export function buildOrderV1Payload(
  terms: SignedOrderTerms,
  scheme: OrderSigningScheme,
): TypedDataPayload {
  return {
    types: {
      [scheme === "qrl-sign-typed-v1" ? "QRLDomain" : "EIP712Domain"]: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "salt", type: "bytes32" },
      ],
      OrderV1: [...ORDER_V1_FIELDS],
    },
    primaryType: "OrderV1",
    domain: { ...ORDER_V1_DOMAIN },
    message: terms,
  };
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
  const eip712 = TypedDataEncoder.hash(
    payload.domain,
    { OrderV1: [...ORDER_V1_FIELDS] },
    payload.message,
  );
  return keccak_256(concatBytes(QRL_MESSAGE_PREFIX, getBytes(eip712)));
}

function verifyProof(
  signer: string,
  auth: MakerOrderAuthV1,
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
  options: { now?: number; allowExpired?: boolean } = {},
): VerifiedOrderV1 {
  const { body, terms: baseTerms } = canonicalOrderBody(rawOrder);
  const auth = parseAuth(rawAuth);
  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (auth.expiresAt <= auth.issuedAt) invalid("signed order expiry must follow issuance");
  if (auth.expiresAt - auth.issuedAt > MAX_ORDER_LIFETIME_S) {
    invalid("signed order lifetime exceeds 48 hours");
  }
  if (auth.issuedAt > now + MAX_CLOCK_SKEW_S) invalid("signed order issuance is in the future");
  if (!options.allowExpired && auth.expiresAt < now + MIN_REMAINING_LIFETIME_S) {
    invalid("signed order is expired or too close to expiry");
  }

  const terms: SignedOrderTerms = {
    ...baseTerms,
    issuedAt: String(auth.issuedAt),
    expiresAt: String(auth.expiresAt),
    nonce: auth.nonce,
  };
  const payload = buildOrderV1Payload(terms, auth.scheme);
  if (!verifyProof(terms.makerQrlAccount, auth, payload)) {
    throw new ApiError(401, "maker signature is invalid");
  }

  return { orderId: auth.nonce.slice(2), order: body, auth };
}
