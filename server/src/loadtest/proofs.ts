// Portable V2 proof construction for the load harness. Terms are assembled
// with the same exported builders the service verifies against, so a harness
// that drifts from the wire format fails loudly, so a run can never quietly
// measure nothing.

import { randomBytes } from "node:crypto";
import {
  ORDER_V1_DEPLOYMENT,
  buildCancelV1Payload,
  buildFillIntentV1Payload,
  buildFillV1Payload,
  buildOrderV1Payload,
  computeMakerTokenCommitment,
  computeReleaseCommitment,
  deriveOrderV1Id,
  orderDigest as computeOrderDigest,
  protocolMessageBytes,
  type CancelV1Terms,
  type FillIntentV1Terms,
  type FillV1Terms,
  type SignedOrderTerms,
} from "../order-signing.js";
import type { Identity } from "./identity.js";

const SCHEME = "qrl-sign-message-v2" as const;
const ZERO_BYTES32 = `0x${"00".repeat(32)}`;
const ETH_CHAIN = ORDER_V1_DEPLOYMENT.ethChainId;

export function randomNonce(): string {
  return `0x${randomBytes(32).toString("hex")}`;
}

export function randomToken(): string {
  return randomBytes(32).toString("hex");
}

export interface UnsignedProof<TBody> {
  body: TBody;
  auth: Record<string, unknown>;
  messageBytes: Uint8Array;
}

export interface OrderBody extends Record<string, unknown> {
  direction: "eth->qrl" | "qrl->eth";
  asset: "ETH";
  fromAmount: string;
  toAmount: string;
  makerEthAccount: string;
  makerQrlAccount: string;
  visibility: "public";
}

export interface PreparedOrder {
  orderId: string;
  orderDigest: string;
  orderNonce: string;
  makerToken: string;
  makerIndex: number;
  issuedAt: number;
  expiresAt: number;
  proof: UnsignedProof<OrderBody>;
}

/** One public, non-prelocked order. Amounts vary per rung, so the seeded book
 *  looks like a real ladder. */
export function prepareOrder(
  maker: Identity,
  rung: number,
  issuedAt: number,
  lifetimeS: number,
): PreparedOrder {
  const fromAmount = String(10n ** 15n * BigInt(10 + (rung % 40)));
  const toAmount = String(10n ** 15n * BigInt(11 + (rung % 40)));
  const nonce = randomNonce();
  const makerToken = randomToken();
  const expiresAt = issuedAt + lifetimeS;
  const body: OrderBody = {
    direction: "eth->qrl",
    asset: "ETH",
    fromAmount,
    toAmount,
    makerEthAccount: maker.ethAccount,
    makerQrlAccount: maker.qrlAccount,
    visibility: "public",
  };
  const makerTokenCommitment = computeMakerTokenCommitment(makerToken);
  const terms: SignedOrderTerms = {
    direction: body.direction,
    asset: body.asset,
    fromAmount,
    toAmount,
    makerEthAccount: `eip155:${ETH_CHAIN}:${maker.ethAccount}`,
    makerQrlAccount: maker.qrlAccount,
    visibility: "public",
    allowedTakerEth: "",
    allowedTakerQrl: "",
    prelocked: false,
    hashlock: ZERO_BYTES32,
    initiatorTimeout: "0",
    issuedAt: String(issuedAt),
    expiresAt: String(expiresAt),
    nonce,
    makerTokenCommitment,
    shareTokenCommitment: ZERO_BYTES32,
    ...ORDER_V1_DEPLOYMENT,
  };
  return {
    orderId: deriveOrderV1Id(maker.qrlAccount, nonce),
    orderDigest: computeOrderDigest(terms),
    orderNonce: nonce,
    makerToken,
    makerIndex: maker.index,
    issuedAt,
    expiresAt,
    proof: {
      body,
      auth: {
        version: "2",
        scheme: SCHEME,
        issuedAt,
        expiresAt,
        nonce,
        signature: "",
        publicKey: maker.publicKey,
        descriptor: maker.descriptor,
        makerTokenCommitment,
        shareTokenCommitment: ZERO_BYTES32,
      },
      messageBytes: protocolMessageBytes(buildOrderV1Payload(terms, SCHEME)),
    },
  };
}

export interface IntentBody extends Record<string, unknown> {
  orderDigest: string;
  takerEthAccount: string;
  takerQrlAccount: string;
  releaseCommitment: string;
}

export interface PreparedIntent {
  orderId: string;
  orderDigest: string;
  takerIndex: number;
  takerIp: string;
  issuedAt: number;
  expiresAt: number;
  proof: UnsignedProof<IntentBody>;
}

/** One FillIntentV2 proposal. The signed lifetime is capped at 120 s by the
 *  protocol, so a pre-signed batch stays valid for a short run only. */
export function prepareIntent(
  taker: Identity,
  order: { orderId: string; orderDigest: string; expiresAt: number },
  issuedAt: number,
  lifetimeS: number,
): PreparedIntent {
  const nonce = randomNonce();
  const expiresAt = Math.min(issuedAt + lifetimeS, order.expiresAt);
  const releaseCommitment = computeReleaseCommitment(
    order.orderDigest,
    nonce,
    randomNonce(),
  );
  const body: IntentBody = {
    orderDigest: order.orderDigest,
    takerEthAccount: taker.ethAccount,
    takerQrlAccount: taker.qrlAccount,
    releaseCommitment,
  };
  const terms: FillIntentV1Terms = {
    orderDigest: order.orderDigest,
    requestNonce: nonce,
    takerEthAccount: `eip155:${ETH_CHAIN}:${taker.ethAccount}`,
    takerQrlAccount: taker.qrlAccount,
    releaseCommitment,
    issuedAt: String(issuedAt),
    expiresAt: String(expiresAt),
    ...ORDER_V1_DEPLOYMENT,
  };
  return {
    orderId: order.orderId,
    orderDigest: order.orderDigest,
    takerIndex: taker.index,
    takerIp: taker.ip,
    issuedAt,
    expiresAt,
    proof: {
      body,
      auth: {
        version: "2",
        scheme: SCHEME,
        issuedAt,
        expiresAt,
        nonce,
        signature: "",
        publicKey: taker.publicKey,
        descriptor: taker.descriptor,
      },
      messageBytes: protocolMessageBytes(
        buildFillIntentV1Payload(terms, SCHEME),
      ),
    },
  };
}

export interface CancelBody extends Record<string, unknown> {
  orderDigest: string;
  reasonCode: number;
}

export interface PreparedCancel {
  orderId: string;
  proof: UnsignedProof<CancelBody>;
}

/** CancelV2 for a public order. Its auth expiry must equal the order's. */
export function prepareCancel(
  maker: Identity,
  order: {
    orderId: string;
    orderDigest: string;
    orderNonce: string;
    expiresAt: number;
  },
  issuedAt: number,
): PreparedCancel {
  const nonce = randomNonce();
  const body: CancelBody = { orderDigest: order.orderDigest, reasonCode: 1 };
  const terms: CancelV1Terms = {
    orderDigest: order.orderDigest,
    orderNonce: order.orderNonce,
    cancelNonce: nonce,
    issuedAt: String(issuedAt),
    reasonCode: body.reasonCode,
    ...ORDER_V1_DEPLOYMENT,
  };
  return {
    orderId: order.orderId,
    proof: {
      body,
      auth: {
        version: "2",
        scheme: SCHEME,
        issuedAt,
        expiresAt: order.expiresAt,
        nonce,
        signature: "",
        publicKey: maker.publicKey,
        descriptor: maker.descriptor,
      },
      messageBytes: protocolMessageBytes(buildCancelV1Payload(terms, SCHEME)),
    },
  };
}

export interface FillBody extends Record<string, unknown> {
  orderDigest: string;
  intentDigest: string;
  takerEthAccount: string;
  takerQrlAccount: string;
  releaseCommitment: string;
  hashlock: string;
  initiatorTimeout: number;
  responderTimeout: number;
}

export interface PreparedFill {
  orderId: string;
  intentDigest: string;
  proof: UnsignedProof<FillBody>;
}

/** FillV2 selecting one admitted intent. Timeout windows satisfy the
 *  initiator >= 2x responder invariant with room for the respondBy check. */
export function prepareFill(
  maker: Identity,
  order: { orderId: string; orderDigest: string; orderNonce: string },
  intent: {
    intentDigest: string;
    takerEthAccount: string;
    takerQrlAccount: string;
    releaseCommitment: string;
  },
  issuedAt: number,
): PreparedFill {
  const nonce = randomNonce();
  const respondBy = issuedAt + 120;
  const responderTimeout = issuedAt + 1800;
  const initiatorTimeout = issuedAt + 3600;
  const body: FillBody = {
    orderDigest: order.orderDigest,
    intentDigest: intent.intentDigest,
    takerEthAccount: intent.takerEthAccount,
    takerQrlAccount: intent.takerQrlAccount,
    releaseCommitment: intent.releaseCommitment,
    hashlock: randomNonce(),
    initiatorTimeout,
    responderTimeout,
  };
  const terms: FillV1Terms = {
    orderDigest: order.orderDigest,
    orderNonce: order.orderNonce,
    intentDigest: intent.intentDigest,
    fillNonce: nonce,
    takerEthAccount: `eip155:${ETH_CHAIN}:${intent.takerEthAccount}`,
    takerQrlAccount: intent.takerQrlAccount,
    releaseCommitment: intent.releaseCommitment,
    hashlock: body.hashlock,
    initiatorTimeout: String(initiatorTimeout),
    responderTimeout: String(responderTimeout),
    issuedAt: String(issuedAt),
    respondBy: String(respondBy),
    ...ORDER_V1_DEPLOYMENT,
  };
  return {
    orderId: order.orderId,
    intentDigest: intent.intentDigest,
    proof: {
      body,
      auth: {
        version: "2",
        scheme: SCHEME,
        issuedAt,
        expiresAt: respondBy,
        nonce,
        signature: "",
        publicKey: maker.publicKey,
        descriptor: maker.descriptor,
      },
      messageBytes: protocolMessageBytes(buildFillV1Payload(terms, SCHEME)),
    },
  };
}

/** Attaches signatures produced by the pool, in preparation order. */
export function attachSignatures<TBody>(
  proofs: readonly UnsignedProof<TBody>[],
  signatures: readonly string[],
): void {
  proofs.forEach((proof, index) => {
    const signature = signatures[index];
    if (signature === undefined) {
      throw new Error(`missing signature for prepared proof ${index}`);
    }
    proof.auth["signature"] = signature;
  });
}
