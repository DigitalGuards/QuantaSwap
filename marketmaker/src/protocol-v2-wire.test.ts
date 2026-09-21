import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import {
  computeMessageDigest,
  SCHEME_TAG_MSG,
  verifyMessageForSigner,
} from "@qrlwallet/connect";
import {
  CryptoBytes,
  CryptoPublicKeyBytes,
  CryptoSecretKeyBytes,
  cryptoSignKeypair,
  cryptoSignSignature,
} from "@theqrl/mldsa87";
import {
  ORDER_V2_DOMAIN,
  ORDER_V2_DEPLOYMENT,
  PROTOCOL_V2_FIELDS,
  protocolMessageBytes,
  assertV2Deployment,
  type ProtocolV2Payload,
} from "./protocol-v2-wire.js";

const vectors = JSON.parse(
  readFileSync(
    new URL("../../config/protocol-v2-vectors.json", import.meta.url),
    "utf8",
  ),
) as { domain: Record<string, string>; expected: Record<string, string> };
const hash = (bytes: Uint8Array) =>
  `0x${createHash("sha256").update(bytes).digest("hex")}`;
const hex = (bytes: Uint8Array) => `0x${Buffer.from(bytes).toString("hex")}`;
const bytes32 = (byte: string) => `0x${byte.repeat(32)}`;
const orderTerms = {
  direction: "eth->qrl",
  asset: "ETH",
  fromAmount: "1000000000000000",
  toAmount: "2000000000000000",
  makerEthAccount: `eip155:11155111:0x${"1".repeat(40)}`,
  makerQrlAccount: `Q${"2".repeat(128)}`,
  visibility: "public",
  allowedTakerEth: "",
  allowedTakerQrl: "",
  prelocked: false,
  hashlock: bytes32("00"),
  initiatorTimeout: "0",
  issuedAt: "1800000000",
  expiresAt: "1800003600",
  nonce: bytes32("42"),
  makerTokenCommitment:
    "0x1c638e915c397db2f42a90c6fa0a7c13260596fd6df47c6a5c2c63e7546c49c9",
  shareTokenCommitment: bytes32("00"),
  ...ORDER_V2_DEPLOYMENT,
};
const artifact = (
  primaryType: string,
  message: Record<string, unknown>,
): ProtocolV2Payload => ({
  primaryType,
  types: { [primaryType]: [...(PROTOCOL_V2_FIELDS[primaryType] ?? [])] },
  domain: { ...ORDER_V2_DOMAIN },
  message,
});
const order = artifact("OrderV2", orderTerms);
const intentTerms = {
  orderDigest: vectors.expected["orderDigest"],
  requestNonce: bytes32("43"),
  takerEthAccount: `eip155:11155111:0x${"2".repeat(40)}`,
  takerQrlAccount: `Q${"3".repeat(128)}`,
  releaseCommitment: vectors.expected["releaseCommitment"],
  issuedAt: "1800000010",
  expiresAt: "1800000130",
  ...ORDER_V2_DEPLOYMENT,
};
const intent = artifact("FillIntentV2", intentTerms);
const fill = artifact("FillV2", {
  orderDigest: vectors.expected["orderDigest"],
  orderNonce: bytes32("42"),
  intentDigest: vectors.expected["intentDigest"],
  fillNonce: bytes32("44"),
  takerEthAccount: intentTerms.takerEthAccount,
  takerQrlAccount: intentTerms.takerQrlAccount,
  releaseCommitment: intentTerms.releaseCommitment,
  hashlock: bytes32("66"),
  initiatorTimeout: "1800003600",
  responderTimeout: "1800001800",
  issuedAt: "1800000020",
  respondBy: "1800000080",
  ...ORDER_V2_DEPLOYMENT,
});
const cancel = artifact("CancelV2", {
  orderDigest: vectors.expected["orderDigest"],
  orderNonce: bytes32("42"),
  cancelNonce: bytes32("45"),
  issuedAt: "1800000030",
  reasonCode: 1,
  ...ORDER_V2_DEPLOYMENT,
});

it("matches the frozen canonical domain and all four V2 semantic wire vectors", () => {
  assertV2Deployment();
  assert.deepEqual(ORDER_V2_DOMAIN, vectors.domain);
  for (const [value, key] of [
    [order, "orderDigest"],
    [intent, "intentDigest"],
    [fill, "fillDigest"],
    [cancel, "cancelDigest"],
  ] as const) {
    assert.equal(hash(protocolMessageBytes(value)), vectors.expected[key]);
  }
  assert.equal(
    hex(computeMessageDigest(protocolMessageBytes(order))),
    vectors.expected["messageDigest"],
  );
  const reordered = {
    ...order,
    message: Object.fromEntries(Object.entries(order.message).reverse()),
  };
  assert.deepEqual(
    protocolMessageBytes(reordered),
    protocolMessageBytes(order),
  );
});

it("rejects altered chain, genesis, contract, primary type, fields and numeric ambiguity", () => {
  for (const key of [
    "version",
    "ethChainId",
    "ethHtlc",
    "qrlChainId",
    "qrlGenesisHash",
    "qrlHtlc",
  ]) {
    assert.throws(
      () =>
        protocolMessageBytes({
          ...order,
          domain: { ...order.domain, [key]: "changed" },
        }),
      /domain/,
    );
  }
  assert.throws(
    () => protocolMessageBytes({ ...order, primaryType: "OrderV1" }),
    /primary type/,
  );
  assert.throws(
    () =>
      protocolMessageBytes({
        ...order,
        message: { ...order.message, extra: "ignored" },
      }),
    /fields/,
  );
  assert.throws(
    () =>
      protocolMessageBytes({
        ...order,
        types: { OrderV2: [...PROTOCOL_V2_FIELDS["OrderV2"]!].reverse() },
      }),
    /schema/,
  );
  for (const invalid of [
    1.5,
    -0,
    "01",
    "-0",
    "1e1",
    "1.0",
    -1,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.throws(
      () =>
        protocolMessageBytes({
          ...order,
          message: { ...order.message, issuedAt: invalid },
        }),
      /integer/,
    );
  }
  assert.throws(
    () =>
      protocolMessageBytes({
        ...cancel,
        message: { ...cancel.message, reasonCode: 256 },
      }),
    /integer/,
  );
  assert.notEqual(
    hash(
      protocolMessageBytes({
        ...order,
        message: { ...order.message, makerQrlAccount: `Q${"2".repeat(127)}3` },
      }),
    ),
    vectors.expected["orderDigest"],
  );
});

it("authenticates exact V2 bytes and all 64 signer bytes under the message context", () => {
  const publicKey = new Uint8Array(CryptoPublicKeyBytes);
  const secretKey = new Uint8Array(CryptoSecretKeyBytes);
  const descriptor = new Uint8Array([1, 0, 0]);
  cryptoSignKeypair(new Uint8Array(32).fill(21), publicKey, secretKey);
  const signer = `Q${createHash("shake256", { outputLength: 64 }).update(descriptor).update(publicKey).digest("hex")}`;
  try {
    for (const value of [order, intent, fill, cancel]) {
      const messageBytes = protocolMessageBytes(value);
      const signature = new Uint8Array(CryptoBytes);
      cryptoSignSignature(
        signature,
        computeMessageDigest(messageBytes),
        secretKey,
        false,
        SCHEME_TAG_MSG,
      );
      const proof = {
        expectedSigner: signer,
        descriptor,
        signature,
        publicKey,
        messageBytes,
      };
      assert.equal(verifyMessageForSigner(proof), true);
      assert.equal(
        verifyMessageForSigner({
          ...proof,
          expectedSigner: signer.slice(0, 41),
        }),
        false,
      );
      assert.equal(
        verifyMessageForSigner({
          ...proof,
          expectedSigner:
            signer.slice(0, -1) + (signer.endsWith("0") ? "1" : "0"),
        }),
        false,
      );
      assert.equal(
        verifyMessageForSigner({
          ...proof,
          descriptor: new Uint8Array([1, 0, 1]),
        }),
        false,
      );
      const changed = Uint8Array.from(messageBytes);
      changed[changed.length - 1] = changed[changed.length - 1]! ^ 1;
      assert.equal(
        verifyMessageForSigner({ ...proof, messageBytes: changed }),
        false,
      );
      cryptoSignSignature(
        signature,
        computeMessageDigest(messageBytes),
        secretKey,
        false,
        new TextEncoder().encode("ZOND"),
      );
      assert.equal(verifyMessageForSigner(proof), false);
    }
  } finally {
    secretKey.fill(0);
  }
});
