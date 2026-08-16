import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  ML_DSA_87_SIGNATURE_BYTES,
  SCHEME_TAG_TYPED,
  computeTypedDataDigest,
} from "@qrlwallet/connect";
import { cryptoSignSignature } from "@theqrl/mldsa87";
import { ExtendedSeed, MLDSA87 } from "@theqrl/wallet.js";
import { getBytes } from "ethers";
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
  deriveOrderV1Id,
  officialQrlDigest,
  verifyFillIntentV1,
  EMPTY_CAPABILITY_COMMITMENT,
  MAKER_CAPABILITY_DOMAIN,
  SHARE_CAPABILITY_DOMAIN,
  type FillIntentV1Body,
  type FillV1Body,
  type OrderSigningScheme,
  type OrderV1Body,
  type ProtocolAuthV1,
} from "./protocol-signing.js";

const NOW = 1_800_000_000;
const EXTENDED_SEED = `0x010000${"07".repeat(48)}`;
const EXPECTED_ADDRESS = "Q806e3ce8587683518b117edc3c3cbcfbe03f110c";
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
    makerTokenCommitment: capabilityCommitment(MAKER_CAPABILITY_DOMAIN, MAKER_TOKEN),
    shareTokenCommitment: EMPTY_CAPABILITY_COMMITMENT,
  };
}

it("derives OrderV1 identity from maker and nonce", () => {
  assert.equal(
    deriveOrderV1Id("Q2222222222222222222222222222222222222222", ORDER_NONCE),
    "cd84c99465b251d67a23548932b13fe84caa67d28c8331686e91774343552e0e",
  );
  assert.notEqual(
    deriveOrderV1Id("Q2222222222222222222222222222222222222222", ORDER_NONCE),
    deriveOrderV1Id("Q3333333333333333333333333333333333333333", ORDER_NONCE),
  );
});

function hex(bytes: Uint8Array): string {
  return `0x${Buffer.from(bytes).toString("hex")}`;
}

function orderBody(makerQrlAccount: string): OrderV1Body {
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
  auth: Pick<ProtocolAuthV1, "signature" | "publicKey">,
  payload: ReturnType<typeof buildOrderV1Payload>,
): boolean {
  return MLDSA87.verify(
    getBytes(auth.signature),
    officialQrlDigest(payload),
    getBytes(auth.publicKey),
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
  const extendedSeed = ExtendedSeed.from(EXTENDED_SEED);
  const wallet = MLDSA87.newWalletFromExtendedSeed(extendedSeed);
  (extendedSeed as typeof extendedSeed & { zeroize(): void }).zeroize();
  const secretKey = wallet.getSK();
  try {
    const orderDigest = expectedOrderDigest;
    const intent: FillIntentV1Body = {
      orderDigest,
      takerEthAccount: "0x2222222222222222222222222222222222222222",
      takerQrlAccount: wallet.getAddressStr(),
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
    const digest =
      scheme === "qrl-sign-typed-v1"
        ? computeTypedDataDigest(payload)
        : officialQrlDigest(payload);
    const signature = new Uint8Array(ML_DSA_87_SIGNATURE_BYTES);
    cryptoSignSignature(
      signature,
      digest,
      secretKey,
      false,
      scheme === "qrl-sign-typed-v1" ? SCHEME_TAG_TYPED : new TextEncoder().encode("ZOND"),
    );
    return {
      intent,
      orderDigest,
      auth: {
        version: "1",
        scheme,
        ...unsigned,
        signature: hex(signature),
        publicKey: hex(wallet.getPK()),
        descriptor: hex(wallet.getDescriptor().toBytes()),
      },
    };
  } finally {
    secretKey.fill(0);
    (wallet as typeof wallet & { zeroize(): void }).zeroize();
  }
}

describe("headless protocol signing", () => {
  it("commits raw capabilities with separate NUL-terminated domains", () => {
    assert.equal(
      capabilityCommitment(MAKER_CAPABILITY_DOMAIN, "00".repeat(32)),
      "0x9ca8274349471eadc293ebb7690d81e64ce538ad0d9d65646f9ff1af227709e6",
    );
    assert.equal(
      capabilityCommitment(SHARE_CAPABILITY_DOMAIN, "11".repeat(32)),
      "0xe0e4441fa2456254d19815bb0b962e160e06027efe181f8f8887292f527590e2",
    );
    assert.notEqual(
      capabilityCommitment(MAKER_CAPABILITY_DOMAIN, "11".repeat(32)),
      capabilityCommitment(SHARE_CAPABILITY_DOMAIN, "11".repeat(32)),
    );
  });

  it("matches the server OrderV1 EIP-712 vector", () => {
    const body = orderBody("Q2222222222222222222222222222222222222222");
    const auth = orderUnsignedAuth(NOW, NOW + 3600, ORDER_NONCE);
    const digest = computeOrderDigest(body, auth);
    assert.equal(digest, "0x5a76e96bdd26891fc5b28848ed2f519a9fee5d8bdc7614692b71a3431c085a48");
    assert.equal(
      hex(officialQrlDigest(buildOrderV1Payload(body, auth))),
      "0xc305e6936db7a0b374f936cb7058fde90963e39896f5d127f25bd87c147211d3",
    );
  });

  it("matches the server capability-aware semantic replay vectors", () => {
    const orderAuth = orderUnsignedAuth(NOW, NOW + 3600, ORDER_NONCE);
    const orderDigest = "0x5a76e96bdd26891fc5b28848ed2f519a9fee5d8bdc7614692b71a3431c085a48";
    const releaseCommitment = computeReleaseCommitment(
      orderDigest,
      REQUEST_NONCE,
      `0x${"55".repeat(32)}`,
    );
    assert.equal(
      releaseCommitment,
      "0xa786c492a3707147bfa3277ddf44d49af0c794252e42dd05379f04b8c4621e0e",
    );
    const intent = {
      orderDigest,
      takerEthAccount: "0x2222222222222222222222222222222222222222",
      takerQrlAccount: "Q3333333333333333333333333333333333333333",
      releaseCommitment,
    };
    const intentAuth = { issuedAt: NOW + 10, expiresAt: NOW + 130, nonce: REQUEST_NONCE };
    const intentDigest = computeFillIntentDigest(intent, intentAuth);
    assert.equal(intentDigest, "0x48f387eff4522d99a48f52ec0e9e8b146fa0deb119383c53ffbb7d134ca00a2b");
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
      "0x6d4d7d0a3fb70062fc6897c9f402353536e3ffeefe7a6e698b5db78cedcb3c13",
    );
    assert.equal(
      computeCancelDigest(
        { orderDigest, reasonCode: 1 },
        orderAuth,
        { issuedAt: NOW + 30, nonce: CANCEL_NONCE },
      ),
      "0xde9d19dc6dd94501ea1fb23ac89295ce139cc2f8566aee99f5b5ca5f83769214",
    );
  });

  it("derives the expected Q address and signs a canonical OrderV1", () => {
    const signer = new ProtocolSigner(EXTENDED_SEED);
    try {
      assert.equal(signer.address, EXPECTED_ADDRESS);
      assert.equal(signer.descriptor, "0x010000");

      const signed = signer.signOrderV1(orderBody(signer.address), {
        makerToken: MAKER_TOKEN,
        issuedAt: NOW,
        expiresAt: NOW + 3600,
        nonce: ORDER_NONCE,
      });
      assert.equal(signed.order.makerQrlAccount, EXPECTED_ADDRESS);
      assert.equal(signed.auth.scheme, "qrl-eip712-v4");
      assert.equal(signed.auth.nonce, ORDER_NONCE);
      assert.equal(
        proofIsValid(signed.auth, buildOrderV1Payload(signed.order, signed.auth)),
        true,
      );

      const changed = { ...signed.order, toAmount: "2000000000000001" };
      assert.equal(
        proofIsValid(signed.auth, buildOrderV1Payload(changed, signed.auth)),
        false,
      );
    } finally {
      signer.close();
    }
  });

  it("links a FillV1 to a deterministic signed intent digest", () => {
    const signer = new ProtocolSigner(EXTENDED_SEED);
    try {
      const order = signer.signOrderV1(orderBody(signer.address), {
        makerToken: MAKER_TOKEN,
        issuedAt: NOW,
        expiresAt: NOW + 3600,
        nonce: ORDER_NONCE,
      });
      const orderDigest = computeOrderDigest(order.order, order.auth);
      const intentFixture = signedIntentFixture("qrl-eip712-v4", {}, orderDigest);
      const intent = intentFixture.intent;
      const intentAuth = intentFixture.auth;
      const intentDigest = computeFillIntentDigest(intent, intentAuth);
      const fill: FillV1Body = {
        orderDigest,
        intentDigest,
        takerEthAccount: intent.takerEthAccount,
        takerQrlAccount: intent.takerQrlAccount,
        releaseCommitment: intent.releaseCommitment,
        hashlock: HASHLOCK,
        initiatorTimeout: NOW + 14_400,
        responderTimeout: NOW + 7_200,
      };
      const signed = signer.signFillV1(fill, {
        order,
        selectedIntent: { intentDigest, intent, auth: intentAuth },
        issuedAt: NOW + 20,
        respondBy: NOW + 320,
        fillNonce: FILL_NONCE,
      });
      const payload = buildFillV1Payload(signed.fill, order.auth, signed.auth);

      assert.equal(intentDigest, computeFillIntentDigest(intent, intentAuth));
      assert.equal(signed.auth.nonce, FILL_NONCE);
      assert.equal(signed.auth.expiresAt, NOW + 320);
      assert.equal(proofIsValid(signed.auth, payload), true);
      assert.equal(
        computeFillDigest(signed.fill, order.auth, signed.auth),
        "0xeb748cf575f57bf1ee44307aaa4eedcc8d2740a433637d8e876109d3a6dd2ac9",
      );

      const changed = { ...signed.fill, hashlock: `0x${"48".repeat(32)}` };
      assert.equal(
        proofIsValid(
          signed.auth,
          buildFillV1Payload(changed, order.auth, signed.auth),
        ),
        false,
      );
    } finally {
      signer.close();
    }
  });

  it("requires a nonzero hashlock and the full live order and intent context", () => {
    const signer = new ProtocolSigner(EXTENDED_SEED);
    try {
      const order = signer.signOrderV1(orderBody(signer.address), {
        makerToken: MAKER_TOKEN,
        issuedAt: NOW,
        expiresAt: NOW + 3600,
        nonce: ORDER_NONCE,
      });
      const orderDigest = computeOrderDigest(order.order, order.auth);
      const fixture = signedIntentFixture("qrl-eip712-v4", {}, orderDigest);
      const intentDigest = computeFillIntentDigest(fixture.intent, fixture.auth);
      const fill: FillV1Body = {
        orderDigest,
        intentDigest,
        takerEthAccount: fixture.intent.takerEthAccount,
        takerQrlAccount: fixture.intent.takerQrlAccount,
        releaseCommitment: fixture.intent.releaseCommitment,
        hashlock: `0x${"00".repeat(32)}`,
        initiatorTimeout: NOW + 7200,
        responderTimeout: NOW + 3600,
      };
      const options = {
        order,
        selectedIntent: { intentDigest, intent: fixture.intent, auth: fixture.auth },
        issuedAt: NOW + 20,
        respondBy: NOW + 320,
        fillNonce: FILL_NONCE,
      };
      assert.throws(() => signer.signFillV1(fill, options), /hashlock cannot be zero/);
      assert.throws(
        () => signer.signFillV1({ ...fill, hashlock: HASHLOCK, intentDigest: `0x${"9".repeat(64)}` }, options),
        /does not authenticate the selected live intent/,
      );
      assert.throws(
        () => signer.signFillV1({ ...fill, hashlock: HASHLOCK }, {
          ...options,
          issuedAt: fixture.auth.expiresAt,
          respondBy: fixture.auth.expiresAt + 60,
        }),
        /does not authenticate the selected live intent|outside its order or intent window/,
      );
    } finally {
      signer.close();
    }
  });

  it("allows a 3h to 72h prelock T1 beyond the ordinary 4h fill cap only on exact match", () => {
    const signer = new ProtocolSigner(EXTENDED_SEED);
    try {
      const order = signer.signOrderV1(
        {
          ...orderBody(signer.address),
          prelock: { hashlock: HASHLOCK, initiatorTimeout: NOW + 6 * 3600 },
        },
        { makerToken: MAKER_TOKEN, issuedAt: NOW, expiresAt: NOW + 3600, nonce: ORDER_NONCE },
      );
      const orderDigest = computeOrderDigest(order.order, order.auth);
      const fixture = signedIntentFixture("qrl-eip712-v4", {}, orderDigest);
      const intentDigest = computeFillIntentDigest(fixture.intent, fixture.auth);
      const fill: FillV1Body = {
        orderDigest,
        intentDigest,
        takerEthAccount: fixture.intent.takerEthAccount,
        takerQrlAccount: fixture.intent.takerQrlAccount,
        releaseCommitment: fixture.intent.releaseCommitment,
        hashlock: HASHLOCK,
        initiatorTimeout: NOW + 6 * 3600,
        responderTimeout: NOW + 3600,
      };
      const options = {
        order,
        selectedIntent: { intentDigest, intent: fixture.intent, auth: fixture.auth },
        issuedAt: NOW + 20,
        respondBy: NOW + 80,
        fillNonce: FILL_NONCE,
      };
      assert.doesNotThrow(() => signer.signFillV1(fill, options));
      assert.throws(
        () => signer.signFillV1({ ...fill, hashlock: `0x${"48".repeat(32)}` }, options),
        /exactly match the signed prelock/,
      );
      assert.throws(
        () => signer.signFillV1({ ...fill, initiatorTimeout: fill.initiatorTimeout + 1 }, options),
        /exactly match the signed prelock/,
      );
    } finally {
      signer.close();
    }
  });

  it("explicitly rejects private signed orders in the headless market maker", () => {
    const signer = new ProtocolSigner(EXTENDED_SEED);
    try {
      assert.throws(
        () => signer.signOrderV1(
          {
            ...orderBody(signer.address),
            visibility: "private",
            allowedTakerEth: "0x2222222222222222222222222222222222222222",
            allowedTakerQrl: signer.address,
          },
          {
            makerToken: MAKER_TOKEN,
            shareToken: "cd".repeat(32),
            issuedAt: NOW,
            expiresAt: NOW + 3600,
            nonce: ORDER_NONCE,
          },
        ),
        /supports public signed orders only/,
      );
    } finally {
      signer.close();
    }
  });

  it("signs a typed cancellation tombstone and rejects reason overflow", () => {
    const signer = new ProtocolSigner(EXTENDED_SEED);
    try {
      const order = signer.signOrderV1(orderBody(signer.address), {
        makerToken: MAKER_TOKEN,
        issuedAt: NOW,
        expiresAt: NOW + 3600,
        nonce: ORDER_NONCE,
      });
      const cancel = signer.signCancelV1(
        {
          orderDigest: computeOrderDigest(order.order, order.auth),
          reasonCode: 1,
        },
        {
          orderNonce: ORDER_NONCE,
          issuedAt: NOW + 30,
          expiresAt: order.auth.expiresAt,
          cancelNonce: CANCEL_NONCE,
        },
      );
      const payload = buildCancelV1Payload(cancel.cancel, order.auth, cancel.auth);

      assert.equal(cancel.auth.nonce, CANCEL_NONCE);
      assert.equal(proofIsValid(cancel.auth, payload), true);
      assert.equal(
        computeCancelDigest(cancel.cancel, order.auth, cancel.auth),
        "0x3a838c3cf2242d520e17d0742f471efa989ce867d8965ce043fcceddad0636c3",
      );
      assert.throws(
        () =>
          signer.signCancelV1(
            { ...cancel.cancel, reasonCode: 256 },
            {
              orderNonce: ORDER_NONCE,
              issuedAt: NOW + 30,
              expiresAt: order.auth.expiresAt,
              cancelNonce: CANCEL_NONCE,
            },
          ),
        /fit uint8/,
      );
    } finally {
      signer.close();
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
      /descriptor 0x010000/,
    );
  });

  for (const scheme of ["qrl-sign-typed-v1", "qrl-eip712-v4"] as const) {
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
        verifyFillIntentV1(fixture.intent, fixture.auth, `0x${"53".repeat(32)}`, {
          now: NOW,
        }),
        false,
      );
    });
  }

  it("rejects noncanonical, expired, overlong, and out-of-order-window intents", () => {
    const fixture = signedIntentFixture("qrl-eip712-v4");
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
        { ...fixture.intent, orderDigest: fixture.intent.orderDigest.toUpperCase() },
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
    const fixture = signedIntentFixture("qrl-eip712-v4", {
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
