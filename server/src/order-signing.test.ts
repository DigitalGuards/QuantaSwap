import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { keccak_256, shake256 } from "@noble/hashes/sha3.js";
import {
  SCHEME_TAG_TYPED,
  computeTypedDataDigest,
} from "@qrlwallet/connect";
import {
  CryptoBytes,
  CryptoPublicKeyBytes,
  CryptoSecretKeyBytes,
  cryptoSignKeypair,
  cryptoSignSignature,
} from "@theqrl/mldsa87";
import { TypedDataEncoder, getBytes } from "ethers";
import {
  ORDER_V1_FIELDS,
  buildOrderV1Payload,
  verifyOrderV1,
  type MakerOrderAuthV1,
  type OrderSigningScheme,
  type SignedOrderTerms,
} from "./order-signing.js";

const NOW = 1_800_000_000;
const DESCRIPTOR = new Uint8Array([1, 0, 0]);
const ZOND_CONTEXT = new TextEncoder().encode("ZOND");
const QRL_MESSAGE_PREFIX = new TextEncoder().encode("\x19QRL Signed Message:\n32");

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function hex(bytes: Uint8Array): string {
  return `0x${Buffer.from(bytes).toString("hex")}`;
}

const publicKey = new Uint8Array(CryptoPublicKeyBytes);
const secretKey = new Uint8Array(CryptoSecretKeyBytes);
cryptoSignKeypair(new Uint8Array(32).fill(7), publicKey, secretKey);
const signer = `Q${Buffer.from(
  shake256(concatBytes(DESCRIPTOR, publicKey), { dkLen: 20 }),
).toString("hex")}`;

function fixture(scheme: OrderSigningScheme): {
  order: Record<string, unknown>;
  auth: MakerOrderAuthV1;
} {
  const order = {
    direction: "eth->qrl",
    asset: "ETH",
    fromAmount: "1000000000000000",
    toAmount: "1000000000000000",
    makerEthAccount: "0x1111111111111111111111111111111111111111",
    makerQrlAccount: signer,
    visibility: "public",
  } as const;
  const auth: MakerOrderAuthV1 = {
    version: "1",
    scheme,
    issuedAt: NOW,
    expiresAt: NOW + 3600,
    nonce: `0x${"42".repeat(32)}`,
    signature: "",
    publicKey: hex(publicKey),
    descriptor: hex(DESCRIPTOR),
  };
  const terms: SignedOrderTerms = {
    ...order,
    makerEthAccount: `eip155:11155111:${order.makerEthAccount}`,
    allowedTakerEth: "",
    allowedTakerQrl: "",
    prelocked: false,
    hashlock: `0x${"00".repeat(32)}`,
    initiatorTimeout: "0",
    issuedAt: String(auth.issuedAt),
    expiresAt: String(auth.expiresAt),
    nonce: auth.nonce,
    ethChainId: "11155111",
    ethHtlc: "eip155:11155111:0x910d5d4a7f2037c01f3b4c835167357e89909281",
    qrlChainId: "1337",
    qrlHtlc: "Q238322ad2e8f935b4481fcc379779c31b84decb0",
  };
  const payload = buildOrderV1Payload(terms, scheme);
  let digest: Uint8Array;
  let context: Uint8Array;
  if (scheme === "qrl-sign-typed-v1") {
    digest = computeTypedDataDigest(payload);
    context = SCHEME_TAG_TYPED;
  } else {
    const eip712 = TypedDataEncoder.hash(
      payload.domain,
      { OrderV1: [...ORDER_V1_FIELDS] },
      payload.message,
    );
    digest = keccak_256(concatBytes(QRL_MESSAGE_PREFIX, getBytes(eip712)));
    context = ZOND_CONTEXT;
  }
  const signature = new Uint8Array(CryptoBytes);
  cryptoSignSignature(signature, digest, secretKey, false, context);
  auth.signature = hex(signature);
  return { order, auth };
}

describe("OrderV1 maker authorization", () => {
  it("matches the official QRL web3 ABI 0.5.0 EIP-712 vector", () => {
    const payload = buildOrderV1Payload(
      {
        direction: "eth->qrl",
        asset: "ETH",
        fromAmount: "1000000000000000",
        toAmount: "2000000000000000",
        makerEthAccount: "eip155:11155111:0x1111111111111111111111111111111111111111",
        makerQrlAccount: "Q2222222222222222222222222222222222222222",
        visibility: "public",
        allowedTakerEth: "",
        allowedTakerQrl: "",
        prelocked: false,
        hashlock: `0x${"00".repeat(32)}`,
        initiatorTimeout: "0",
        issuedAt: "1800000000",
        expiresAt: "1800003600",
        nonce: `0x${"42".repeat(32)}`,
        ethChainId: "11155111",
        ethHtlc: "eip155:11155111:0x910d5d4a7f2037c01f3b4c835167357e89909281",
        qrlChainId: "1337",
        qrlHtlc: "Q238322ad2e8f935b4481fcc379779c31b84decb0",
      },
      "qrl-eip712-v4",
    );
    assert.equal(
      TypedDataEncoder.hash(
        payload.domain,
        { OrderV1: [...ORDER_V1_FIELDS] },
        payload.message,
      ),
      "0xd822b6033a8e089ad0af54605be20f2957bbafa4d855df04104ac4978cc85035",
    );
  });

  for (const scheme of ["qrl-sign-typed-v1", "qrl-eip712-v4"] as const) {
    it(`verifies and derives a stable id for ${scheme}`, () => {
      const { order, auth } = fixture(scheme);
      const verified = verifyOrderV1(order, auth, { now: NOW });
      assert.equal(verified.orderId, "42".repeat(32));
      assert.equal(verified.auth.scheme, scheme);
    });

    it(`rejects changed economic terms for ${scheme}`, () => {
      const { order, auth } = fixture(scheme);
      assert.throws(
        () => verifyOrderV1({ ...order, toAmount: "2000000000000000" }, auth, { now: NOW }),
        /maker signature is invalid/,
      );
    });
  }

  it("rejects replay after the signed expiry", () => {
    const { order, auth } = fixture("qrl-sign-typed-v1");
    assert.throws(
      () => verifyOrderV1(order, auth, { now: auth.expiresAt }),
      /expired or too close to expiry/,
    );
  });

  it("rejects non-canonical addresses before signature verification", () => {
    const { order, auth } = fixture("qrl-sign-typed-v1");
    assert.throws(
      () =>
        verifyOrderV1(
          { ...order, makerEthAccount: "0x111111111111111111111111111111111111111A" },
          auth,
          { now: NOW },
        ),
      /makerEthAccount is invalid/,
    );
  });
});
