import { shake256 } from "@noble/hashes/sha3.js";
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
const MAX_CLOCK_SKEW_S = 5 * 60;
const ZERO_HASHLOCK = `0x${"00".repeat(32)}`;
const ZOND_CONTEXT = new TextEncoder().encode("ZOND");
const QRL_MESSAGE_PREFIX = toUtf8Bytes("\x19QRL Signed Message:\n32");
const ETH_ADDR_RE = /^0x[0-9a-f]{40}$/;
const QRL_ADDR_RE = /^Q[0-9a-f]{40}$/;
const AMOUNT_RE = /^(?:0|[1-9][0-9]{0,29})$/;
const BYTES32_RE = /^0x[0-9a-f]{64}$/;
const SIGNATURE_RE = new RegExp(`^0x[0-9a-f]{${SIGNATURE_BYTES * 2}}$`);
const PUBLIC_KEY_RE = new RegExp(`^0x[0-9a-f]{${PUBLIC_KEY_BYTES * 2}}$`);
const DESCRIPTOR_RE = /^0x[0-9a-f]{6}$/;

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

function normalizeOrderBody(body: CreateOrderBody): CreateOrderBody {
  const visibility = body.visibility ?? "public";
  return {
    direction: body.direction,
    asset: body.asset,
    fromAmount: BigInt(body.fromAmount).toString(),
    toAmount: BigInt(body.toAmount).toString(),
    makerEthAccount: body.makerEthAccount.toLowerCase(),
    makerQrlAccount: `Q${body.makerQrlAccount.slice(1).toLowerCase()}`,
    visibility,
    ...(body.allowedTakerEth
      ? { allowedTakerEth: body.allowedTakerEth.toLowerCase() }
      : {}),
    ...(body.allowedTakerQrl
      ? { allowedTakerQrl: `Q${body.allowedTakerQrl.slice(1).toLowerCase()}` }
      : {}),
    ...(body.prelock
      ? {
          prelock: {
            hashlock: body.prelock.hashlock.toLowerCase(),
            initiatorTimeout: body.prelock.initiatorTimeout,
          },
        }
      : {}),
  };
}

function nonceHex(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function canonicalWalletHex(raw: unknown, bytes: number, field: string): string {
  if (typeof raw !== "string") throw new Error(`Wallet returned no ${field}`);
  const value = raw.startsWith("0x") ? raw.slice(2) : raw;
  if (value.length !== bytes * 2 || !/^[0-9a-fA-F]+$/.test(value)) {
    throw new Error(`Wallet returned an invalid ${field}`);
  }
  return `0x${value.toLowerCase()}`;
}

export function buildOrderV1Payload(
  order: CreateOrderBody,
  auth: Pick<MakerOrderAuthV1, "scheme" | "issuedAt" | "expiresAt" | "nonce">,
): QrlTypedDataPayload {
  return {
    types: {
      [auth.scheme === "qrl-sign-typed-v1" ? "QRLDomain" : "EIP712Domain"]: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "salt", type: "bytes32" },
      ],
      OrderV1: [...ORDER_V1_FIELDS],
    },
    primaryType: "OrderV1",
    domain: { ...ORDER_V1_DOMAIN },
    message: {
      direction: order.direction,
      asset: order.asset,
      fromAmount: order.fromAmount,
      toAmount: order.toAmount,
      makerEthAccount: `eip155:${ORDER_V1_DEPLOYMENT.ethChainId}:${order.makerEthAccount}`,
      makerQrlAccount: order.makerQrlAccount,
      visibility: order.visibility ?? "public",
      allowedTakerEth:
        order.allowedTakerEth === undefined
          ? ""
          : `eip155:${ORDER_V1_DEPLOYMENT.ethChainId}:${order.allowedTakerEth}`,
      allowedTakerQrl: order.allowedTakerQrl ?? "",
      prelocked: order.prelock !== undefined,
      hashlock: order.prelock?.hashlock ?? ZERO_HASHLOCK,
      initiatorTimeout: String(order.prelock?.initiatorTimeout ?? 0),
      issuedAt: String(auth.issuedAt),
      expiresAt: String(auth.expiresAt),
      nonce: auth.nonce,
      ...ORDER_V1_DEPLOYMENT,
    },
  };
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
}): Promise<{ order: CreateOrderBody; auth: MakerOrderAuthV1 }> {
  const scheme = orderSigningSchemeForWallet(walletRdns);
  if (scheme === null) {
    throw new Error(
      "This QRL wallet cannot sign portable orders. Use MyQRLWallet or the official QRL Web3 Wallet.",
    );
  }
  const requestedSigner = body.makerQrlAccount;
  const order = normalizeOrderBody(body);
  const expiresAt = Math.min(
    now + ORDER_LIFETIME_S,
    order.prelock?.initiatorTimeout ?? Number.POSITIVE_INFINITY,
  );
  const unsignedAuth = {
    scheme,
    issuedAt: now,
    expiresAt,
    nonce: nonceHex(),
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
  return {
    order,
    auth: {
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
    },
  };
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

function officialProofIsValid(
  signer: string,
  auth: MakerOrderAuthV1,
  payload: QrlTypedDataPayload,
): boolean {
  if (auth.descriptor !== "0x010000") return false;
  const descriptor = getBytes(auth.descriptor);
  const publicKey = getBytes(auth.publicKey);
  const address = shake256(concatBytes(descriptor, publicKey), { dkLen: 20 });
  const derived = `Q${Array.from(address, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  if (derived !== signer) return false;
  const eip712 = TypedDataEncoder.hash(
    payload.domain,
    { OrderV1: [...ORDER_V1_FIELDS] },
    payload.message,
  );
  const digest = getBytes(keccak256(concat([QRL_MESSAGE_PREFIX, getBytes(eip712)])));
  return cryptoSignVerify(
    getBytes(auth.signature),
    digest,
    publicKey,
    ZOND_CONTEXT,
  );
}

/** Independently authenticate an order returned by a book. This is run
 *  before take confirmation; the server's claim that it verified a proof
 *  is not itself a trust boundary. */
export function verifyOrderV1Auth(
  order: OrderView,
  now = Math.floor(Date.now() / 1000),
): boolean {
  try {
    const auth = order.makerAuth;
    if (
      auth === undefined ||
      auth.version !== "1" ||
      (auth.scheme !== "qrl-sign-typed-v1" && auth.scheme !== "qrl-eip712-v4") ||
      !Number.isSafeInteger(auth.issuedAt) ||
      !Number.isSafeInteger(auth.expiresAt) ||
      auth.issuedAt < 0 ||
      auth.expiresAt <= auth.issuedAt ||
      auth.expiresAt - auth.issuedAt > ORDER_LIFETIME_S ||
      auth.issuedAt > now + MAX_CLOCK_SKEW_S ||
      auth.expiresAt <= now ||
      !BYTES32_RE.test(auth.nonce) ||
      order.id !== auth.nonce.slice(2) ||
      !SIGNATURE_RE.test(auth.signature) ||
      !PUBLIC_KEY_RE.test(auth.publicKey) ||
      !DESCRIPTOR_RE.test(auth.descriptor) ||
      order.asset === undefined ||
      !AMOUNT_RE.test(order.fromAmount) ||
      !AMOUNT_RE.test(order.toAmount) ||
      !ETH_ADDR_RE.test(order.makerEthAccount) ||
      !QRL_ADDR_RE.test(order.makerQrlAccount) ||
      (order.visibility !== "public" && order.visibility !== "private")
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
    return officialProofIsValid(order.makerQrlAccount, auth, payload);
  } catch {
    return false;
  }
}
