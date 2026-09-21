import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { Descriptor, ExtendedSeed, MLDSA87 } from "@theqrl/wallet.js";
import { getBytes } from "ethers";
import {
  V2_TEST_EXTENDED_SEED,
  protocolV2Identity,
  signProtocolV2Auth,
} from "./protocol-v2-test-helper.js";
import {
  ProtocolSigner,
  capabilityCommitment,
  buildCancelV1Payload,
  buildFillIntentV1Payload,
  buildFillV1Payload,
  buildOrderV1Payload,
  computeCancelDigest,
  computeFillDigest,
  computeFillIntentDigest,
  computeOrderDigest,
  computeReleaseCommitment,
  deriveLegacyV1QrlAddress,
  deriveOrderV1Id,
  officialQrlDigest,
  verifyFillIntentV1,
  verifyOfficialV1Proof,
  EMPTY_CAPABILITY_COMMITMENT,
  MAKER_CAPABILITY_DOMAIN,
  SHARE_CAPABILITY_DOMAIN,
  type FillIntentV1Body,
  type CanonicalOrderV1Body,
  type OrderSigningScheme,
  type ProtocolAuthV1,
} from "./protocol-signing.js";

const NOW = 1_800_000_000;
const EXTENDED_SEED = V2_TEST_EXTENDED_SEED;
const EXPECTED_LEGACY_ADDRESS = "Q806e3ce8587683518b117edc3c3cbcfbe03f110c";
const EXPECTED_CURRENT_ADDRESS =
  "Q806E3Ce8587683518b117EdC3c3CBCFBE03F110cc997b6E928424c96cd4409Fb1BA5c426802096Fb6E14C932E283EC7B78B0769E09cd726F93e0c2279149a80b";
const ORDER_NONCE = `0x${"42".repeat(32)}`;
const REQUEST_NONCE = `0x${"43".repeat(32)}`;
const FILL_NONCE = `0x${"44".repeat(32)}`;
const CANCEL_NONCE = `0x${"45".repeat(32)}`;
const RELEASE_COMMITMENT = `0x${"46".repeat(32)}`;
const HASHLOCK = `0x${"47".repeat(32)}`;
const MAKER_TOKEN = "ab".repeat(32);

function orderUnsignedAuth(issuedAt: number, expiresAt: number, nonce: string) {
  return {
    issuedAt,
    expiresAt,
    nonce,
    makerTokenCommitment: capabilityCommitment(
      MAKER_CAPABILITY_DOMAIN,
      MAKER_TOKEN,
    ),
    shareTokenCommitment: EMPTY_CAPABILITY_COMMITMENT,
  };
}

it("derives OrderV1 identity from maker and nonce", () => {
  assert.equal(
    deriveOrderV1Id(
      "Q22222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222",
      ORDER_NONCE,
    ),
    "680f1ac51008253a70792f659dfd37f2371ee2f3fcddf853605e8eea2711f079",
  );
  assert.notEqual(
    deriveOrderV1Id(
      "Q22222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222",
      ORDER_NONCE,
    ),
    deriveOrderV1Id(
      "Q33333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333",
      ORDER_NONCE,
    ),
  );
});

function hex(bytes: Uint8Array): string {
  return `0x${Buffer.from(bytes).toString("hex")}`;
}

function orderBody(makerQrlAccount: string): CanonicalOrderV1Body {
  return {
    direction: "eth->qrl",
    asset: "ETH",
    fromAmount: "1000000000000000",
    toAmount: "2000000000000000",
    makerEthAccount: "0x1111111111111111111111111111111111111111",
    makerQrlAccount,
    visibility: "public",
  };
}

function proofIsValid(
  auth: Pick<ProtocolAuthV1, "signature" | "publicKey" | "descriptor">,
  payload: ReturnType<typeof buildOrderV1Payload>,
  signer = `Q${EXPECTED_CURRENT_ADDRESS.slice(1).toLowerCase()}`,
): boolean {
  return verifyOfficialV1Proof(
    signer,
    { ...auth, scheme: "qrl-sign-message-v2" },
    payload,
  );
}

function signedIntentFixture(
  scheme: OrderSigningScheme,
  messageOverrides: Record<string, unknown> = {},
  expectedOrderDigest = `0x${"51".repeat(32)}`,
): {
  intent: FillIntentV1Body;
  auth: ProtocolAuthV1;
  orderDigest: string;
} {
  const identity = protocolV2Identity();
  const orderDigest = expectedOrderDigest;
  const intent: FillIntentV1Body = {
    orderDigest,
    takerEthAccount: "0x2222222222222222222222222222222222222222",
    takerQrlAccount: identity.currentAddress,
    releaseCommitment: RELEASE_COMMITMENT,
  };
  const unsigned = {
    issuedAt: NOW,
    expiresAt: NOW + 120,
    nonce: REQUEST_NONCE,
  };
  const canonicalPayload = buildFillIntentV1Payload(intent, unsigned, scheme);
  const payload = {
    ...canonicalPayload,
    message: { ...canonicalPayload.message, ...messageOverrides },
  };
  return {
    intent,
    orderDigest,
    auth: signProtocolV2Auth(payload, scheme, unsigned),
  };
}

function signedOrderFixture() {
  const identity = protocolV2Identity();
  const order = orderBody(identity.currentAddress);
  const unsignedAuth = orderUnsignedAuth(NOW, NOW + 3600, ORDER_NONCE);
  const auth = {
    ...signProtocolV2Auth(
      buildOrderV1Payload(order, unsignedAuth),
      "qrl-sign-message-v2",
      unsignedAuth,
    ),
    makerTokenCommitment: unsignedAuth.makerTokenCommitment,
    shareTokenCommitment: unsignedAuth.shareTokenCommitment,
  };
  return { identity, order, auth };
}

describe("headless protocol signing", () => {
  it("commits raw capabilities with separate NUL-terminated domains", () => {
    assert.equal(
      capabilityCommitment(MAKER_CAPABILITY_DOMAIN, "00".repeat(32)),
      "0x59aa4f3115692702a2fac436240f220c24b278d6e8720a6bd0ddc697cbdd1549",
    );
    assert.equal(
      capabilityCommitment(SHARE_CAPABILITY_DOMAIN, "11".repeat(32)),
      "0x35ce99bb9155eaf860a94bfcb1669cceca9acd5351c89e2d2a65ae2e5a4a6b30",
    );
    assert.notEqual(
      capabilityCommitment(MAKER_CAPABILITY_DOMAIN, "11".repeat(32)),
      capabilityCommitment(SHARE_CAPABILITY_DOMAIN, "11".repeat(32)),
    );
  });

  it("matches the server V2 canonical message vector", () => {
    const body = orderBody(
      "Q22222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222",
    );
    const auth = orderUnsignedAuth(NOW, NOW + 3600, ORDER_NONCE);
    const digest = computeOrderDigest(body, auth);
    assert.equal(
      digest,
      "0xda031198a8064c9afbf37a3d8a0246dfc7cad2af8abebc215aa2cdc07964a5a4",
    );
    assert.equal(
      hex(officialQrlDigest(buildOrderV1Payload(body, auth))),
      "0x49306e3003652005268fb015ed71399dd033ac02c95bf03aa03a7d674d71cf27e2935d293120dd4cfaa0d61fefcad60249a3e5113e495197bb50a6084566202c",
    );
  });

  it("matches the server capability-aware semantic replay vectors", () => {
    const orderAuth = orderUnsignedAuth(NOW, NOW + 3600, ORDER_NONCE);
    const orderDigest =
      "0xda031198a8064c9afbf37a3d8a0246dfc7cad2af8abebc215aa2cdc07964a5a4";
    const releaseCommitment = computeReleaseCommitment(
      orderDigest,
      REQUEST_NONCE,
      `0x${"55".repeat(32)}`,
    );
    assert.equal(
      releaseCommitment,
      "0x43b8a0a54301cd814f20e5108484dc36c6b75c5666bddea13f58fe649fc81133",
    );
    const intent = {
      orderDigest,
      takerEthAccount: "0x2222222222222222222222222222222222222222",
      takerQrlAccount:
        "Q33333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333",
      releaseCommitment,
    };
    const intentAuth = {
      issuedAt: NOW + 10,
      expiresAt: NOW + 130,
      nonce: REQUEST_NONCE,
    };
    const intentDigest = computeFillIntentDigest(intent, intentAuth);
    assert.equal(
      intentDigest,
      "0xadce8e5a9ce6cacd0148f3a5c0aee4771a144a8c7755e8f50a327128c036b7e5",
    );
    assert.equal(
      computeFillDigest(
        {
          ...intent,
          intentDigest,
          hashlock: `0x${"66".repeat(32)}`,
          initiatorTimeout: NOW + 3600,
          responderTimeout: NOW + 1800,
        },
        orderAuth,
        { issuedAt: NOW + 20, expiresAt: NOW + 80, nonce: FILL_NONCE },
      ),
      "0x2666b9a4c6129fe84abe8f583d50dee8474375420f8dc4370b443a8a021fcd0a",
    );
    assert.equal(
      computeCancelDigest({ orderDigest, reasonCode: 1 }, orderAuth, {
        issuedAt: NOW + 30,
        nonce: CANCEL_NONCE,
      }),
      "0xeb767418bc586392a19dc549c6e4498fa5f7f4e9d324e72945b13abd03e298dd",
    );
  });

  it("binds the seed to the full Q128 identity and signs a V2 order", () => {
    const signer = new ProtocolSigner(EXTENDED_SEED);
    try {
      assert.equal(
        signer.address,
        "Q" + EXPECTED_CURRENT_ADDRESS.slice(1).toLowerCase(),
      );
      assert.equal(
        deriveLegacyV1QrlAddress(signer.descriptor, signer.publicKey),
        EXPECTED_LEGACY_ADDRESS,
      );
      const signed = signer.signOrderV1(orderBody(signer.address), {
        makerToken: MAKER_TOKEN,
        issuedAt: NOW,
        expiresAt: NOW + 3600,
        nonce: ORDER_NONCE,
      });
      assert.equal(signed.auth.version, "2");
      assert.equal(signed.auth.scheme, "qrl-sign-message-v2");
      assert.equal(
        proofIsValid(
          signed.auth,
          buildOrderV1Payload(signed.order, signed.auth),
          signer.address,
        ),
        true,
      );
      assert.equal(
        proofIsValid(
          signed.auth,
          buildOrderV1Payload(signed.order, signed.auth),
          EXPECTED_LEGACY_ADDRESS,
        ),
        false,
      );
      const orderDigest = computeOrderDigest(signed.order, signed.auth);
      const selected = signedIntentFixture(
        "qrl-sign-message-v2",
        {},
        orderDigest,
      );
      const intentDigest = computeFillIntentDigest(
        selected.intent,
        selected.auth,
      );
      const fill = signer.signFillV1(
        {
          ...selected.intent,
          intentDigest,
          hashlock: HASHLOCK,
          initiatorTimeout: NOW + 14_400,
          responderTimeout: NOW + 7_200,
        },
        {
          order: signed,
          selectedIntent: {
            intentDigest,
            intent: selected.intent,
            auth: selected.auth,
          },
          issuedAt: NOW + 20,
          respondBy: NOW + 320,
          fillNonce: FILL_NONCE,
        },
      );
      assert.equal(
        verifyOfficialV1Proof(
          signer.address,
          fill.auth,
          buildFillV1Payload(fill.fill, signed.auth, fill.auth),
        ),
        true,
      );
      const cancel = signer.signCancelV1(
        { orderDigest, reasonCode: 1 },
        {
          orderNonce: signed.auth.nonce,
          issuedAt: NOW + 30,
          expiresAt: signed.auth.expiresAt,
          cancelNonce: CANCEL_NONCE,
        },
      );
      assert.equal(
        verifyOfficialV1Proof(
          signer.address,
          cancel.auth,
          buildCancelV1Payload(cancel.cancel, signed.auth, cancel.auth),
        ),
        true,
      );
    } finally {
      signer.close();
    }
  });

  it("verifies V2 order, fill, and cancel fixtures", () => {
    const order = signedOrderFixture();
    const orderPayload = buildOrderV1Payload(order.order, order.auth);
    assert.equal(
      proofIsValid(order.auth, orderPayload, order.identity.currentAddress),
      true,
    );
    assert.equal(
      proofIsValid(
        order.auth,
        buildOrderV1Payload(
          { ...order.order, toAmount: "2000000000000001" },
          order.auth,
        ),
        order.identity.currentAddress,
      ),
      false,
    );

    const orderDigest = computeOrderDigest(order.order, order.auth);
    const intentFixture = signedIntentFixture(
      "qrl-sign-message-v2",
      {},
      orderDigest,
    );
    const intentDigest = computeFillIntentDigest(
      intentFixture.intent,
      intentFixture.auth,
    );
    const fill = {
      orderDigest,
      intentDigest,
      takerEthAccount: intentFixture.intent.takerEthAccount,
      takerQrlAccount: intentFixture.intent.takerQrlAccount,
      releaseCommitment: intentFixture.intent.releaseCommitment,
      hashlock: HASHLOCK,
      initiatorTimeout: NOW + 14_400,
      responderTimeout: NOW + 7_200,
    };
    const fillUnsigned = {
      issuedAt: NOW + 20,
      expiresAt: NOW + 320,
      nonce: FILL_NONCE,
    };
    const fillAuth = signProtocolV2Auth(
      buildFillV1Payload(fill, order.auth, fillUnsigned),
      "qrl-sign-message-v2",
      fillUnsigned,
    );
    assert.equal(
      verifyOfficialV1Proof(
        order.identity.currentAddress,
        fillAuth,
        buildFillV1Payload(fill, order.auth, fillAuth),
      ),
      true,
    );
    assert.equal(
      computeFillDigest(fill, order.auth, fillAuth),
      "0x036a1105f4f96224a2423616c37fa334e18aa1d51a178530739f2b06f4076b28",
    );

    const cancel = { orderDigest, reasonCode: 1 };
    const cancelUnsigned = {
      issuedAt: NOW + 30,
      expiresAt: order.auth.expiresAt,
      nonce: CANCEL_NONCE,
    };
    const cancelAuth = signProtocolV2Auth(
      buildCancelV1Payload(cancel, order.auth, cancelUnsigned),
      "qrl-sign-message-v2",
      cancelUnsigned,
    );
    assert.equal(
      verifyOfficialV1Proof(
        order.identity.currentAddress,
        cancelAuth,
        buildCancelV1Payload(cancel, order.auth, cancelAuth),
      ),
      true,
    );
    assert.equal(
      computeCancelDigest(cancel, order.auth, cancelAuth),
      "0x5f7460d8d57766301caed78aab496939c5c70c0ff7d3ba006f3efd00d6be9c04",
    );
    assert.throws(
      () =>
        buildCancelV1Payload(
          { ...cancel, reasonCode: 256 },
          order.auth,
          cancelAuth,
        ),
      /fit uint8/,
    );
  });

  it("keeps legacy ZOND and current descriptor signing contexts separate", () => {
    const order = signedOrderFixture();
    const payload = buildOrderV1Payload(order.order, order.auth);
    const digest = officialQrlDigest(payload);
    const extendedSeed = ExtendedSeed.from(EXTENDED_SEED);
    const wallet = MLDSA87.newWalletFromExtendedSeed(extendedSeed);
    (extendedSeed as typeof extendedSeed & { zeroize(): void }).zeroize();
    try {
      const descriptorSignature = wallet.sign(digest);
      const descriptor = Descriptor.from(getBytes(order.auth.descriptor));
      assert.equal(
        verifyOfficialV1Proof(
          order.identity.currentAddress,
          { ...order.auth, signature: hex(descriptorSignature) },
          payload,
        ),
        false,
      );
      assert.equal(
        MLDSA87.verify(
          descriptorSignature,
          digest,
          getBytes(order.auth.publicKey),
          descriptor,
        ),
        true,
      );
      assert.equal(
        MLDSA87.verify(
          getBytes(order.auth.signature),
          digest,
          getBytes(order.auth.publicKey),
          descriptor,
        ),
        false,
      );
    } finally {
      (wallet as typeof wallet & { zeroize(): void }).zeroize();
    }
  });

  it("zeroizes and permanently closes the signing wallet", () => {
    const signer = new ProtocolSigner(EXTENDED_SEED);
    signer.close();
    signer.close();
    assert.throws(
      () =>
        signer.signOrderV1(orderBody(signer.address), {
          makerToken: MAKER_TOKEN,
          issuedAt: NOW,
          expiresAt: NOW + 3600,
          nonce: ORDER_NONCE,
        }),
      /signer is closed/,
    );
  });

  it("refuses an extended seed with noncanonical descriptor metadata", () => {
    assert.throws(
      () => new ProtocolSigner(`0x010001${"07".repeat(48)}`),
      /Descriptor metadata bytes are reserved and must be zero/,
    );
  });

  for (const scheme of ["qrl-sign-message-v2"] as const) {
    it(`independently verifies a canonical ${scheme} FillIntentV1`, () => {
      const fixture = signedIntentFixture(scheme);
      assert.equal(
        verifyFillIntentV1(fixture.intent, fixture.auth, fixture.orderDigest, {
          now: NOW,
          orderIssuedAt: NOW - 60,
          orderExpiresAt: NOW + 3600,
        }),
        true,
      );
      assert.equal(
        verifyFillIntentV1(
          { ...fixture.intent, takerQrlAccount: `Q${"52".repeat(20)}` },
          fixture.auth,
          fixture.orderDigest,
          { now: NOW },
        ),
        false,
      );
      assert.equal(
        verifyFillIntentV1(
          fixture.intent,
          fixture.auth,
          `0x${"53".repeat(32)}`,
          {
            now: NOW,
          },
        ),
        false,
      );
    });
  }

  it("rejects noncanonical, expired, overlong, and out-of-order-window intents", () => {
    const fixture = signedIntentFixture("qrl-sign-message-v2");
    assert.equal(
      verifyFillIntentV1(
        { ...fixture.intent, extra: true },
        fixture.auth,
        fixture.orderDigest,
        { now: NOW },
      ),
      false,
    );
    assert.equal(
      verifyFillIntentV1(
        {
          ...fixture.intent,
          orderDigest: fixture.intent.orderDigest.toUpperCase(),
        },
        fixture.auth,
        fixture.orderDigest,
        { now: NOW },
      ),
      false,
    );
    assert.equal(
      verifyFillIntentV1(
        fixture.intent,
        { ...fixture.auth, extra: true },
        fixture.orderDigest,
        { now: NOW },
      ),
      false,
    );
    assert.equal(
      verifyFillIntentV1(
        fixture.intent,
        { ...fixture.auth, expiresAt: NOW },
        fixture.orderDigest,
        { now: NOW },
      ),
      false,
    );
    assert.equal(
      verifyFillIntentV1(
        fixture.intent,
        { ...fixture.auth, expiresAt: fixture.auth.issuedAt + 121 },
        fixture.orderDigest,
        { now: NOW },
      ),
      false,
    );
    assert.equal(
      verifyFillIntentV1(fixture.intent, fixture.auth, fixture.orderDigest, {
        now: NOW,
        orderIssuedAt: NOW + 1,
      }),
      false,
    );
    assert.equal(
      verifyFillIntentV1(fixture.intent, fixture.auth, fixture.orderDigest, {
        now: NOW,
        orderExpiresAt: NOW + 119,
      }),
      false,
    );
  });

  it("rejects a proof signed for another HTLC deployment", () => {
    const fixture = signedIntentFixture("qrl-sign-message-v2", {
      qrlHtlc: `Q${"54".repeat(20)}`,
    });
    assert.equal(
      verifyFillIntentV1(fixture.intent, fixture.auth, fixture.orderDigest, {
        now: NOW,
      }),
      false,
    );
  });
});
