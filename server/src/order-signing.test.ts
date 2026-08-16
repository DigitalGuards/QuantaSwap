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
  CANCEL_V1_FIELDS,
  FILL_INTENT_V1_FIELDS,
  FILL_V1_FIELDS,
  ORDER_V1_FIELDS,
  ORDER_V1_DEPLOYMENT,
  buildCancelV1Payload,
  buildFillIntentV1Payload,
  buildFillV1Payload,
  buildOrderV1Payload,
  cancelDigest,
  computeReleaseCommitment,
  computeMakerTokenCommitment,
  computeShareTokenCommitment,
  deriveOrderV1Id,
  fillDigest,
  intentDigest,
  orderDigest,
  verifyCancelV1,
  verifyFillIntentV1,
  verifyFillV1,
  verifyOrderV1,
  type CancelV1Body,
  type CancelV1Terms,
  type FillIntentV1Body,
  type FillIntentV1Terms,
  type FillV1Body,
  type FillV1Terms,
  type MakerOrderAuthV1,
  type OrderSigningScheme,
  type ProtocolAuthV1,
  type SignedOrderTerms,
  type VerifiedFillIntentV1,
  type VerifiedOrderV1,
} from "./order-signing.js";

const NOW = 1_800_000_000;
const DESCRIPTOR = new Uint8Array([1, 0, 0]);
const ZOND_CONTEXT = new TextEncoder().encode("ZOND");
const QRL_MESSAGE_PREFIX = new TextEncoder().encode("\x19QRL Signed Message:\n32");
const MAKER_TOKEN = "ab".repeat(32);
const MAKER_TOKEN_COMMITMENT = computeMakerTokenCommitment(MAKER_TOKEN);
const ZERO_SHARE_COMMITMENT = `0x${"00".repeat(32)}`;

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

const takerPublicKey = new Uint8Array(CryptoPublicKeyBytes);
const takerSecretKey = new Uint8Array(CryptoSecretKeyBytes);
cryptoSignKeypair(new Uint8Array(32).fill(8), takerPublicKey, takerSecretKey);
const takerSigner = `Q${Buffer.from(
  shake256(concatBytes(DESCRIPTOR, takerPublicKey), { dkLen: 20 }),
).toString("hex")}`;

function signAuth<T extends ProtocolAuthV1>(
  auth: T,
  payload: ReturnType<typeof buildOrderV1Payload>,
  signingKey: Uint8Array,
): T {
  let digest: Uint8Array;
  let context: Uint8Array;
  if (auth.scheme === "qrl-sign-typed-v1") {
    digest = computeTypedDataDigest(payload);
    context = SCHEME_TAG_TYPED;
  } else {
    const fields = payload.types[payload.primaryType];
    assert.ok(fields);
    const eip712 = TypedDataEncoder.hash(
      payload.domain,
      { [payload.primaryType]: [...fields] },
      payload.message,
    );
    digest = keccak_256(concatBytes(QRL_MESSAGE_PREFIX, getBytes(eip712)));
    context = ZOND_CONTEXT;
  }
  const signature = new Uint8Array(CryptoBytes);
  cryptoSignSignature(signature, digest, signingKey, false, context);
  return { ...auth, signature: hex(signature) };
}

function fixture(
  scheme: OrderSigningScheme,
  options: { prelockTimeout?: number } = {},
): {
  order: Record<string, unknown>;
  auth: MakerOrderAuthV1;
} {
  const prelockHash = `0x${"aa".repeat(32)}`;
  const order: Record<string, unknown> = {
    direction: "eth->qrl",
    asset: "ETH",
    fromAmount: "1000000000000000",
    toAmount: "1000000000000000",
    makerEthAccount: "0x1111111111111111111111111111111111111111",
    makerQrlAccount: signer,
    visibility: "public",
    ...(options.prelockTimeout !== undefined
      ? {
          prelock: {
            hashlock: prelockHash,
            initiatorTimeout: options.prelockTimeout,
          },
        }
      : {}),
  };
  const auth: MakerOrderAuthV1 = {
    version: "1",
    scheme,
    issuedAt: NOW,
    expiresAt: NOW + 3600,
    nonce: `0x${"42".repeat(32)}`,
    signature: "",
    publicKey: hex(publicKey),
    descriptor: hex(DESCRIPTOR),
    makerTokenCommitment: MAKER_TOKEN_COMMITMENT,
    shareTokenCommitment: ZERO_SHARE_COMMITMENT,
  };
  const terms: SignedOrderTerms = {
    direction: "eth->qrl",
    asset: "ETH",
    fromAmount: "1000000000000000",
    toAmount: "1000000000000000",
    makerEthAccount: "eip155:11155111:0x1111111111111111111111111111111111111111",
    makerQrlAccount: signer,
    visibility: "public",
    allowedTakerEth: "",
    allowedTakerQrl: "",
    prelocked: options.prelockTimeout !== undefined,
    hashlock: options.prelockTimeout === undefined ? `0x${"00".repeat(32)}` : prelockHash,
    initiatorTimeout:
      options.prelockTimeout === undefined ? "0" : String(options.prelockTimeout),
    issuedAt: String(auth.issuedAt),
    expiresAt: String(auth.expiresAt),
    nonce: auth.nonce,
    makerTokenCommitment: auth.makerTokenCommitment,
    shareTokenCommitment: auth.shareTokenCommitment,
    ethChainId: "11155111",
    ethHtlc: "eip155:11155111:0x910d5d4a7f2037c01f3b4c835167357e89909281",
    qrlChainId: "1337",
    qrlHtlc: "Q238322ad2e8f935b4481fcc379779c31b84decb0",
  };
  const payload = buildOrderV1Payload(terms, scheme);
  return { order, auth: signAuth(auth, payload, secretKey) };
}

interface ProtocolFixture {
  order: VerifiedOrderV1;
  intentBody: FillIntentV1Body;
  intentAuth: ProtocolAuthV1;
  intent: VerifiedFillIntentV1;
  fillBody: FillV1Body;
  fillAuth: ProtocolAuthV1;
  cancelBody: CancelV1Body;
  cancelAuth: ProtocolAuthV1;
}

function protocolFixture(
  scheme: OrderSigningScheme,
  options: { prelockTimeout?: number } = {},
): ProtocolFixture {
  const signedOrder = fixture(scheme, options);
  const order = verifyOrderV1(signedOrder.order, signedOrder.auth, { now: NOW });
  const requestNonce = `0x${"43".repeat(32)}`;
  const releaseCommitment = computeReleaseCommitment(
    order.orderDigest,
    requestNonce,
    `0x${"55".repeat(32)}`,
  );
  const intentBody: FillIntentV1Body = {
    orderDigest: order.orderDigest,
    takerEthAccount: "0x2222222222222222222222222222222222222222",
    takerQrlAccount: takerSigner,
    releaseCommitment,
  };
  const unsignedIntentAuth: ProtocolAuthV1 = {
    version: "1",
    scheme,
    issuedAt: NOW + 10,
    expiresAt: NOW + 130,
    nonce: requestNonce,
    signature: "",
    publicKey: hex(takerPublicKey),
    descriptor: hex(DESCRIPTOR),
  };
  const intentTerms: FillIntentV1Terms = {
    orderDigest: intentBody.orderDigest,
    requestNonce,
    takerEthAccount: `eip155:11155111:${intentBody.takerEthAccount}`,
    takerQrlAccount: intentBody.takerQrlAccount,
    releaseCommitment,
    issuedAt: String(unsignedIntentAuth.issuedAt),
    expiresAt: String(unsignedIntentAuth.expiresAt),
    ...ORDER_V1_DEPLOYMENT,
  };
  const intentAuth = signAuth(
    unsignedIntentAuth,
    buildFillIntentV1Payload(intentTerms, scheme),
    takerSecretKey,
  );
  const intent = verifyFillIntentV1(intentBody, intentAuth, order, { now: NOW + 11 });

  const initiatorTimeout = options.prelockTimeout ?? NOW + 3_600;
  const responderTimeout =
    options.prelockTimeout === undefined ? NOW + 1_800 : NOW + 3_800;
  const fillBody: FillV1Body = {
    orderDigest: order.orderDigest,
    intentDigest: intent.intentDigest,
    takerEthAccount: intentBody.takerEthAccount,
    takerQrlAccount: intentBody.takerQrlAccount,
    releaseCommitment,
    hashlock:
      options.prelockTimeout === undefined
        ? `0x${"66".repeat(32)}`
        : order.terms.hashlock,
    initiatorTimeout,
    responderTimeout,
  };
  const unsignedFillAuth: ProtocolAuthV1 = {
    version: "1",
    scheme,
    issuedAt: NOW + 20,
    expiresAt: NOW + 80,
    nonce: `0x${"44".repeat(32)}`,
    signature: "",
    publicKey: hex(publicKey),
    descriptor: hex(DESCRIPTOR),
  };
  const fillTerms: FillV1Terms = {
    orderDigest: fillBody.orderDigest,
    orderNonce: order.auth.nonce,
    intentDigest: fillBody.intentDigest,
    fillNonce: unsignedFillAuth.nonce,
    takerEthAccount: `eip155:11155111:${fillBody.takerEthAccount}`,
    takerQrlAccount: fillBody.takerQrlAccount,
    releaseCommitment,
    hashlock: fillBody.hashlock,
    initiatorTimeout: String(fillBody.initiatorTimeout),
    responderTimeout: String(fillBody.responderTimeout),
    issuedAt: String(unsignedFillAuth.issuedAt),
    respondBy: String(unsignedFillAuth.expiresAt),
    ...ORDER_V1_DEPLOYMENT,
  };
  const fillAuth = signAuth(
    unsignedFillAuth,
    buildFillV1Payload(fillTerms, scheme),
    secretKey,
  );

  const cancelBody: CancelV1Body = {
    orderDigest: order.orderDigest,
    reasonCode: 1,
  };
  const unsignedCancelAuth: ProtocolAuthV1 = {
    version: "1",
    scheme,
    issuedAt: NOW + 30,
    expiresAt: order.auth.expiresAt,
    nonce: `0x${"45".repeat(32)}`,
    signature: "",
    publicKey: hex(publicKey),
    descriptor: hex(DESCRIPTOR),
  };
  const cancelTerms: CancelV1Terms = {
    orderDigest: cancelBody.orderDigest,
    orderNonce: order.auth.nonce,
    cancelNonce: unsignedCancelAuth.nonce,
    issuedAt: String(unsignedCancelAuth.issuedAt),
    reasonCode: cancelBody.reasonCode,
    ...ORDER_V1_DEPLOYMENT,
  };
  const cancelAuth = signAuth(
    unsignedCancelAuth,
    buildCancelV1Payload(cancelTerms, scheme),
    secretKey,
  );

  return {
    order,
    intentBody,
    intentAuth,
    intent,
    fillBody,
    fillAuth,
    cancelBody,
    cancelAuth,
  };
}

describe("OrderV1 maker authorization", () => {
  it("matches the official QRL web3 ABI 0.5.0 EIP-712 vector", () => {
    const terms: SignedOrderTerms = {
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
      makerTokenCommitment: MAKER_TOKEN_COMMITMENT,
      shareTokenCommitment: ZERO_SHARE_COMMITMENT,
      ethChainId: "11155111",
      ethHtlc: "eip155:11155111:0x910d5d4a7f2037c01f3b4c835167357e89909281",
      qrlChainId: "1337",
      qrlHtlc: "Q238322ad2e8f935b4481fcc379779c31b84decb0",
    };
    const payload = buildOrderV1Payload(terms, "qrl-eip712-v4");
    const eip712Digest = TypedDataEncoder.hash(
      payload.domain,
      { OrderV1: [...ORDER_V1_FIELDS] },
      payload.message,
    );
    assert.equal(
      eip712Digest,
      "0x5a76e96bdd26891fc5b28848ed2f519a9fee5d8bdc7614692b71a3431c085a48",
    );
    assert.equal(
      hex(keccak_256(concatBytes(QRL_MESSAGE_PREFIX, getBytes(eip712Digest)))),
      "0xc305e6936db7a0b374f936cb7058fde90963e39896f5d127f25bd87c147211d3",
    );
    assert.equal(
      orderDigest(terms),
      "0x5a76e96bdd26891fc5b28848ed2f519a9fee5d8bdc7614692b71a3431c085a48",
    );
  });

  for (const scheme of ["qrl-sign-typed-v1", "qrl-eip712-v4"] as const) {
    it(`verifies and derives a stable id for ${scheme}`, () => {
      const { order, auth } = fixture(scheme);
      const verified = verifyOrderV1(order, auth, { now: NOW });
      assert.equal(verified.orderId, deriveOrderV1Id(signer, auth.nonce));
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

  it("derives order identity from the maker and nonce", () => {
    const nonce = `0x${"42".repeat(32)}`;
    assert.equal(
      deriveOrderV1Id("Q2222222222222222222222222222222222222222", nonce),
      "cd84c99465b251d67a23548932b13fe84caa67d28c8331686e91774343552e0e",
    );
    assert.notEqual(
      deriveOrderV1Id("Q2222222222222222222222222222222222222222", nonce),
      deriveOrderV1Id("Q3333333333333333333333333333333333333333", nonce),
    );
  });

  it("binds nonzero create capabilities to order visibility", () => {
    const { order, auth } = fixture("qrl-sign-typed-v1");
    assert.throws(
      () =>
        verifyOrderV1(
          order,
          { ...auth, makerTokenCommitment: ZERO_SHARE_COMMITMENT },
          { now: NOW },
        ),
      /makerTokenCommitment cannot be zero/,
    );
    assert.throws(
      () =>
        verifyOrderV1(
          order,
          {
            ...auth,
            shareTokenCommitment: computeShareTokenCommitment("11".repeat(32)),
          },
          { now: NOW },
        ),
      /shareTokenCommitment does not match order visibility/,
    );
    assert.throws(
      () =>
        verifyOrderV1(
          { ...order, visibility: "private" },
          auth,
          { now: NOW },
        ),
      /shareTokenCommitment does not match order visibility/,
    );
  });

  it("rejects unsigned OrderV1 and prelock extension fields", () => {
    const { order, auth } = fixture("qrl-sign-typed-v1");
    assert.throws(
      () => verifyOrderV1({ ...order, note: "unsigned" }, auth, { now: NOW }),
      /order.note is not supported/,
    );
    assert.throws(
      () => verifyOrderV1(order, { ...auth, note: "unsigned" }, { now: NOW }),
      /auth.note is not supported/,
    );

    const prelocked = fixture("qrl-sign-typed-v1", { prelockTimeout: NOW + 7200 });
    const prelock = prelocked.order["prelock"] as Record<string, unknown>;
    assert.throws(
      () =>
        verifyOrderV1(
          { ...prelocked.order, prelock: { ...prelock, note: "unsigned" } },
          prelocked.auth,
          { now: NOW },
        ),
      /order.prelock.note is not supported/,
    );
  });

  it("rejects a prelocked order whose proof outlives its escrow", () => {
    const { order, auth } = fixture("qrl-sign-typed-v1", {
      prelockTimeout: NOW + 1800,
    });
    assert.throws(
      () => verifyOrderV1(order, auth, { now: NOW }),
      /expiry exceeds the prelock timeout/,
    );
  });
});

describe("federated order protocol signing", () => {
  it("keeps the canonical typed field order stable", () => {
    assert.deepEqual(
      ORDER_V1_FIELDS.map((field) => field.name),
      [
        "direction",
        "asset",
        "fromAmount",
        "toAmount",
        "makerEthAccount",
        "makerQrlAccount",
        "visibility",
        "allowedTakerEth",
        "allowedTakerQrl",
        "prelocked",
        "hashlock",
        "initiatorTimeout",
        "issuedAt",
        "expiresAt",
        "nonce",
        "makerTokenCommitment",
        "shareTokenCommitment",
        "ethChainId",
        "ethHtlc",
        "qrlChainId",
        "qrlHtlc",
      ],
    );
    assert.deepEqual(
      FILL_INTENT_V1_FIELDS.map((field) => field.name),
      [
        "orderDigest",
        "requestNonce",
        "takerEthAccount",
        "takerQrlAccount",
        "releaseCommitment",
        "issuedAt",
        "expiresAt",
        "ethChainId",
        "ethHtlc",
        "qrlChainId",
        "qrlHtlc",
      ],
    );
    assert.deepEqual(
      FILL_V1_FIELDS.map((field) => field.name),
      [
        "orderDigest",
        "orderNonce",
        "intentDigest",
        "fillNonce",
        "takerEthAccount",
        "takerQrlAccount",
        "releaseCommitment",
        "hashlock",
        "initiatorTimeout",
        "responderTimeout",
        "issuedAt",
        "respondBy",
        "ethChainId",
        "ethHtlc",
        "qrlChainId",
        "qrlHtlc",
      ],
    );
    assert.deepEqual(
      CANCEL_V1_FIELDS.map((field) => field.name),
      [
        "orderDigest",
        "orderNonce",
        "cancelNonce",
        "issuedAt",
        "reasonCode",
        "ethChainId",
        "ethHtlc",
        "qrlChainId",
        "qrlHtlc",
      ],
    );
  });

  it("computes a fixed-width release capability commitment", () => {
    assert.equal(
      computeMakerTokenCommitment("00".repeat(32)),
      "0x9ca8274349471eadc293ebb7690d81e64ce538ad0d9d65646f9ff1af227709e6",
    );
    assert.equal(
      computeShareTokenCommitment("11".repeat(32)),
      "0xe0e4441fa2456254d19815bb0b962e160e06027efe181f8f8887292f527590e2",
    );
    assert.equal(
      computeReleaseCommitment(
        `0x${"11".repeat(32)}`,
        `0x${"22".repeat(32)}`,
        `0x${"33".repeat(32)}`,
      ),
      "0x5fc8c5fdfc3b3df859a6d0883c794662e325ff10147adb67f6ac7a677e442702",
    );
    assert.throws(
      () =>
        computeReleaseCommitment(
          `0x${"11".repeat(31)}`,
          `0x${"22".repeat(32)}`,
          `0x${"33".repeat(32)}`,
        ),
      /orderDigest is invalid/,
    );
  });

  it("keeps semantic replay digest vectors stable", () => {
    const orderDigestValue =
      "0x5a76e96bdd26891fc5b28848ed2f519a9fee5d8bdc7614692b71a3431c085a48";
    const requestNonce = `0x${"43".repeat(32)}`;
    const releaseCommitment = computeReleaseCommitment(
      orderDigestValue,
      requestNonce,
      `0x${"55".repeat(32)}`,
    );
    const intentTerms: FillIntentV1Terms = {
      orderDigest: orderDigestValue,
      requestNonce,
      takerEthAccount: "eip155:11155111:0x2222222222222222222222222222222222222222",
      takerQrlAccount: "Q3333333333333333333333333333333333333333",
      releaseCommitment,
      issuedAt: "1800000010",
      expiresAt: "1800000130",
      ...ORDER_V1_DEPLOYMENT,
    };
    const intentDigestValue = intentDigest(intentTerms);
    const fillTerms: FillV1Terms = {
      orderDigest: orderDigestValue,
      orderNonce: `0x${"42".repeat(32)}`,
      intentDigest: intentDigestValue,
      fillNonce: `0x${"44".repeat(32)}`,
      takerEthAccount: intentTerms.takerEthAccount,
      takerQrlAccount: intentTerms.takerQrlAccount,
      releaseCommitment,
      hashlock: `0x${"66".repeat(32)}`,
      initiatorTimeout: "1800003600",
      responderTimeout: "1800001800",
      issuedAt: "1800000020",
      respondBy: "1800000080",
      ...ORDER_V1_DEPLOYMENT,
    };
    const cancelTerms: CancelV1Terms = {
      orderDigest: orderDigestValue,
      orderNonce: `0x${"42".repeat(32)}`,
      cancelNonce: `0x${"45".repeat(32)}`,
      issuedAt: "1800000030",
      reasonCode: 1,
      ...ORDER_V1_DEPLOYMENT,
    };
    assert.equal(
      releaseCommitment,
      "0xa786c492a3707147bfa3277ddf44d49af0c794252e42dd05379f04b8c4621e0e",
    );
    assert.equal(
      intentDigestValue,
      "0x48f387eff4522d99a48f52ec0e9e8b146fa0deb119383c53ffbb7d134ca00a2b",
    );
    assert.equal(
      fillDigest(fillTerms),
      "0x6d4d7d0a3fb70062fc6897c9f402353536e3ffeefe7a6e698b5db78cedcb3c13",
    );
    assert.equal(
      cancelDigest(cancelTerms),
      "0xde9d19dc6dd94501ea1fb23ac89295ce139cc2f8566aee99f5b5ca5f83769214",
    );
  });

  const verifiedByScheme = new Map<
    OrderSigningScheme,
    {
      orderDigest: string;
      intentDigest: string;
      fillDigest: string;
      cancelDigest: string;
    }
  >();

  for (const scheme of ["qrl-sign-typed-v1", "qrl-eip712-v4"] as const) {
    it(`verifies intent, fill, and cancellation for ${scheme}`, () => {
      const value = protocolFixture(scheme);
      const verifiedFill = verifyFillV1(
        value.fillBody,
        value.fillAuth,
        value.order,
        value.intent,
        { now: NOW + 21 },
      );
      const verifiedCancel = verifyCancelV1(
        value.cancelBody,
        value.cancelAuth,
        value.order,
        { now: NOW + 31 },
      );
      assert.equal(value.intent.terms.takerEthAccount, "eip155:11155111:0x2222222222222222222222222222222222222222");
      assert.equal(verifiedFill.fill.takerEthAccount, value.intentBody.takerEthAccount);
      assert.equal(verifiedFill.terms.respondBy, String(value.fillAuth.expiresAt));
      assert.equal(verifiedCancel.terms.reasonCode, 1);
      assert.equal(intentDigest(value.intent.terms), value.intent.intentDigest);
      assert.equal(fillDigest(verifiedFill.terms), verifiedFill.fillDigest);
      assert.equal(cancelDigest(verifiedCancel.terms), verifiedCancel.cancelDigest);
      verifiedByScheme.set(scheme, {
        orderDigest: value.order.orderDigest,
        intentDigest: value.intent.intentDigest,
        fillDigest: verifiedFill.fillDigest,
        cancelDigest: verifiedCancel.cancelDigest,
      });
    });
  }

  it("uses scheme-independent semantic replay digests", () => {
    const native = verifiedByScheme.get("qrl-sign-typed-v1");
    const official = verifiedByScheme.get("qrl-eip712-v4");
    assert.ok(native);
    assert.ok(official);
    assert.deepEqual(native, official);
  });

  it("rejects terminal proofs that do not derive the OrderV1 maker", () => {
    const value = protocolFixture("qrl-sign-typed-v1");
    const foreignFillAuth = {
      ...value.fillAuth,
      publicKey: hex(takerPublicKey),
    };
    assert.throws(
      () =>
        verifyFillV1(
          value.fillBody,
          foreignFillAuth,
          value.order,
          value.intent,
          { now: NOW + 21 },
        ),
      /maker signature is invalid/,
    );
    assert.throws(
      () =>
        verifyCancelV1(
          value.cancelBody,
          { ...value.cancelAuth, scheme: "qrl-eip712-v4" },
          value.order,
          { now: NOW + 31 },
        ),
      /maker signature is invalid/,
    );
  });

  it("accepts scheme-independent terminal proofs from the same maker", () => {
    const native = protocolFixture("qrl-sign-typed-v1");
    const official = protocolFixture("qrl-eip712-v4");
    assert.equal(native.order.orderDigest, official.order.orderDigest);
    assert.doesNotThrow(() =>
      verifyFillV1(
        official.fillBody,
        official.fillAuth,
        native.order,
        official.intent,
        { now: NOW + 21 },
      ),
    );
    assert.doesNotThrow(() =>
      verifyCancelV1(
        official.cancelBody,
        official.cancelAuth,
        native.order,
        { now: NOW + 31 },
      ),
    );
  });

  it("binds fill taker terms to the signed intent", () => {
    const value = protocolFixture("qrl-sign-typed-v1");
    assert.throws(
      () =>
        verifyFillV1(
          {
            ...value.fillBody,
            takerEthAccount: "0x3333333333333333333333333333333333333333",
          },
          value.fillAuth,
          value.order,
          value.intent,
          { now: NOW + 21 },
        ),
      /taker terms do not match/,
    );
  });

  it("enforces intent lifetime and fill deadline invariants", () => {
    const value = protocolFixture("qrl-sign-typed-v1");
    assert.throws(
      () =>
        verifyFillIntentV1(
          value.intentBody,
          { ...value.intentAuth, expiresAt: value.intentAuth.issuedAt + 121 },
          value.order,
          { now: NOW + 11 },
        ),
      /lifetime exceeds 120 seconds/,
    );
    assert.throws(
      () =>
        verifyFillV1(
          value.fillBody,
          { ...value.fillAuth, expiresAt: value.fillAuth.issuedAt + 59 },
          value.order,
          value.intent,
          { now: NOW + 21 },
        ),
      /respondBy must be 60 to 900 seconds/,
    );
    assert.throws(
      () =>
        verifyFillV1(
          {
            ...value.fillBody,
            responderTimeout: value.fillAuth.expiresAt + 600,
          },
          value.fillAuth,
          value.order,
          value.intent,
          { now: NOW + 21 },
        ),
      /more than 600 seconds after respondBy/,
    );
    assert.throws(
      () =>
        verifyFillV1(
          { ...value.fillBody, initiatorTimeout: NOW + 3_000 },
          value.fillAuth,
          value.order,
          value.intent,
          { now: NOW + 21 },
        ),
      /at least twice the responder window/,
    );
  });

  it("requires exact signed prelock terms and runway", () => {
    const value = protocolFixture("qrl-sign-typed-v1", {
      prelockTimeout: NOW + 12_000,
    });
    assert.doesNotThrow(() =>
      verifyFillV1(value.fillBody, value.fillAuth, value.order, value.intent, {
        now: NOW + 21,
      }),
    );
    assert.throws(
      () =>
        verifyFillV1(
          { ...value.fillBody, hashlock: `0x${"77".repeat(32)}` },
          value.fillAuth,
          value.order,
          value.intent,
          { now: NOW + 21 },
        ),
      /must match the signed prelock/,
    );

  });

  it("binds cancel expiry to the original signed order", () => {
    const value = protocolFixture("qrl-sign-typed-v1");
    assert.throws(
      () =>
        verifyCancelV1(
          value.cancelBody,
          { ...value.cancelAuth, expiresAt: value.cancelAuth.expiresAt - 1 },
          value.order,
          { now: NOW + 31 },
        ),
      /must equal the signed order expiry/,
    );
  });

  it("rejects non-canonical extension fields", () => {
    const value = protocolFixture("qrl-sign-typed-v1");
    assert.throws(
      () =>
        verifyFillIntentV1(
          { ...value.intentBody, unsupported: true },
          value.intentAuth,
          value.order,
          { now: NOW + 11 },
        ),
      /unsupported is not supported/,
    );
    assert.throws(
      () =>
        verifyFillIntentV1(
          value.intentBody,
          { ...value.intentAuth, unsupported: true },
          value.order,
          { now: NOW + 11 },
        ),
      /unsupported is not supported/,
    );
  });

  it("allows expired artifacts only during hydration", () => {
    const value = protocolFixture("qrl-sign-typed-v1");
    assert.throws(
      () =>
        verifyFillIntentV1(value.intentBody, value.intentAuth, value.order, {
          now: NOW + 5_000,
        }),
      /referenced order is expired/,
    );
    assert.doesNotThrow(() =>
      verifyFillIntentV1(value.intentBody, value.intentAuth, value.order, {
        now: NOW + 5_000,
        allowExpired: true,
      }),
    );
    assert.doesNotThrow(() =>
      verifyFillV1(value.fillBody, value.fillAuth, value.order, value.intent, {
        now: NOW + 5_000,
        allowExpired: true,
      }),
    );
    assert.doesNotThrow(() =>
      verifyCancelV1(value.cancelBody, value.cancelAuth, value.order, {
        now: NOW + 5_000,
        allowExpired: true,
      }),
    );
  });
});
