// Taker-side authentication of untrusted book rows. Every case here is a
// row a hostile or broken book could serve; none of them may reach the
// funding path.

import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { after, describe, it } from "node:test";
import {
  MAKER_CAPABILITY_DOMAIN,
  EMPTY_CAPABILITY_COMMITMENT,
  ProtocolSigner,
  buildOrderV1Payload,
  capabilityCommitment,
  computeFillDigest,
  computeFillIntentDigest,
  computeOrderDigest,
  deriveOrderV1Id,
  type SignedFillIntentV1,
  type SignedFillV1,
  type SignedOrderV1,
} from "./protocol-signing.js";
import {
  V2_TEST_EXTENDED_SEED,
  signProtocolV2Auth,
} from "./protocol-v2-test-helper.js";
import {
  FundingBlockedError,
  parseBookOrderRow,
  sameSignedIntent,
  verifyMakerCancel,
  verifyMakerFill,
  verifyMakerOrder,
  verifyOwnIntent,
  type BookOrderRow,
} from "./taker-proofs.js";

const TAKER_SEED = `0x010000${"09".repeat(48)}`;
const maker = new ProtocolSigner(V2_TEST_EXTENDED_SEED);
const taker = new ProtocolSigner(TAKER_SEED);
after(() => {
  maker.close();
  taker.close();
});

const NOW = 1_800_000_000;
const MAKER_ETH = `0x${"a".repeat(40)}`;
const TAKER_ETH = `0x${"c".repeat(40)}`;
const FROM_AMOUNT = (2n * 10n ** 16n).toString();
const TO_AMOUNT = (2n * 10n ** 18n).toString();

function signOrder(overrides: { issuedAt?: number; expiresAt?: number } = {}): SignedOrderV1 {
  const issuedAt = overrides.issuedAt ?? NOW - 60;
  return maker.signOrderV1(
    {
      direction: "eth->qrl",
      asset: "ETH",
      fromAmount: FROM_AMOUNT,
      toAmount: TO_AMOUNT,
      makerEthAccount: MAKER_ETH,
      makerQrlAccount: maker.address,
    },
    {
      makerToken: randomBytes(32).toString("hex"),
      issuedAt,
      expiresAt: overrides.expiresAt ?? issuedAt + 3600,
    },
  );
}

const PRELOCK_HASHLOCK = `0x${"5a".repeat(32)}`;

/** Sign an order body the reference signer would refuse, which is what a
 *  maker running its own client can publish. */
function signRawOrder(args: {
  prelock: { hashlock: string; initiatorTimeout: number };
  issuedAt: number;
  expiresAt: number;
}): SignedOrderV1 {
  const order = {
    direction: "eth->qrl" as const,
    asset: "ETH" as const,
    fromAmount: FROM_AMOUNT,
    toAmount: TO_AMOUNT,
    makerEthAccount: MAKER_ETH,
    makerQrlAccount: maker.address,
    visibility: "public" as const,
    prelock: args.prelock,
  };
  const unsigned = {
    issuedAt: args.issuedAt,
    expiresAt: args.expiresAt,
    nonce: `0x${randomBytes(32).toString("hex")}`,
    makerTokenCommitment: capabilityCommitment(
      MAKER_CAPABILITY_DOMAIN,
      randomBytes(32).toString("hex"),
    ),
    shareTokenCommitment: EMPTY_CAPABILITY_COMMITMENT,
  };
  const auth = signProtocolV2Auth(
    buildOrderV1Payload(order, unsigned),
    "qrl-sign-message-v2",
    unsigned,
  );
  return {
    order,
    auth: {
      ...auth,
      makerTokenCommitment: unsigned.makerTokenCommitment,
      shareTokenCommitment: unsigned.shareTokenCommitment,
    },
  };
}

function prelockedRow(order: SignedOrderV1): Record<string, unknown> {
  const prelock = order.order.prelock;
  return {
    ...openRow(order),
    prelocked: true,
    hashlock: prelock?.hashlock ?? null,
    initiatorTimeout: prelock?.initiatorTimeout ?? null,
  };
}

function openRow(order: SignedOrderV1): Record<string, unknown> {
  return {
    id: deriveOrderV1Id(order.order.makerQrlAccount, order.auth.nonce),
    direction: order.order.direction,
    asset: order.order.asset,
    fromAmount: order.order.fromAmount,
    toAmount: order.order.toAmount,
    makerEthAccount: order.order.makerEthAccount,
    makerQrlAccount: order.order.makerQrlAccount,
    status: "open",
    takerEthAccount: null,
    takerQrlAccount: null,
    hashlock: null,
    initiatorTimeout: null,
    responderTimeout: null,
    released: false,
    makerSeen: true,
    visibility: "public",
    prelocked: false,
    makerAuth: order.auth,
    orderDigest: computeOrderDigest(order.order, order.auth),
    createdAt: NOW - 60,
    updatedAt: NOW - 60,
  };
}

function signIntent(
  order: SignedOrderV1,
  issuedAt = NOW,
): { signed: SignedFillIntentV1; digest: string; releaseSecret: string } {
  const releaseSecret = `0x${randomBytes(32).toString("hex")}`;
  const signed = taker.signFillIntentV1({
    order,
    orderDigest: computeOrderDigest(order.order, order.auth),
    takerEthAccount: TAKER_ETH,
    releaseSecret,
    issuedAt,
  });
  return {
    signed,
    digest: computeFillIntentDigest(signed.intent, signed.auth),
    releaseSecret,
  };
}

function signFill(
  order: SignedOrderV1,
  intent: SignedFillIntentV1,
  overrides: {
    issuedAt?: number;
    initiatorTimeout?: number;
    responderTimeout?: number;
    respondBy?: number;
  } = {},
): SignedFillV1 {
  const issuedAt = overrides.issuedAt ?? NOW + 5;
  return maker.signFillV1(
    {
      orderDigest: computeOrderDigest(order.order, order.auth),
      intentDigest: computeFillIntentDigest(intent.intent, intent.auth),
      takerEthAccount: intent.intent.takerEthAccount,
      takerQrlAccount: intent.intent.takerQrlAccount,
      releaseCommitment: intent.intent.releaseCommitment,
      hashlock: `0x${"12".repeat(32)}`,
      initiatorTimeout: overrides.initiatorTimeout ?? issuedAt + 7200,
      responderTimeout: overrides.responderTimeout ?? issuedAt + 3600,
    },
    {
      order,
      selectedIntent: {
        intentDigest: computeFillIntentDigest(intent.intent, intent.auth),
        intent: intent.intent,
        auth: intent.auth,
      },
      issuedAt,
      respondBy: overrides.respondBy ?? issuedAt + 300,
    },
  );
}

function lockingRow(
  order: SignedOrderV1,
  intent: SignedFillIntentV1,
  fill: SignedFillV1,
): Record<string, unknown> {
  return {
    ...openRow(order),
    status: "locking",
    takerEthAccount: fill.fill.takerEthAccount,
    takerQrlAccount: fill.fill.takerQrlAccount,
    hashlock: fill.fill.hashlock,
    initiatorTimeout: fill.fill.initiatorTimeout,
    responderTimeout: fill.fill.responderTimeout,
    fill: fill.fill,
    fillAuth: fill.auth,
    fillDigest: computeFillDigest(fill.fill, order.auth, fill.auth),
    selectedIntent: {
      intentDigest: computeFillIntentDigest(intent.intent, intent.auth),
      intent: intent.intent,
      auth: intent.auth,
      receivedAt: NOW,
    },
  };
}

function recoveryFor(intent: SignedFillIntentV1, order: SignedOrderV1) {
  return {
    orderDigest: computeOrderDigest(order.order, order.auth),
    intent,
    intentDigest: computeFillIntentDigest(intent.intent, intent.auth),
  };
}

describe("book row parsing", () => {
  it("parses a well formed open row", () => {
    const row = parseBookOrderRow(openRow(signOrder()));
    assert.equal(row.status, "open");
    assert.equal(row.visibility, "public");
    assert.equal(row.released, false);
  });

  it("refuses a row carrying unknown fields", () => {
    assert.throws(
      () => parseBookOrderRow({ ...openRow(signOrder()), surprise: 1 }),
      /unsupported fields/,
    );
  });

  it("refuses a malformed maker account", () => {
    assert.throws(() =>
      parseBookOrderRow({ ...openRow(signOrder()), makerEthAccount: "0xnope" }),
    );
  });

  it("refuses a maker auth missing its capability commitments", () => {
    const order = signOrder();
    const { makerTokenCommitment: _drop, ...auth } = order.auth;
    void _drop;
    assert.throws(() =>
      parseBookOrderRow({ ...openRow(order), makerAuth: auth }),
    );
  });
});

describe("maker order verification", () => {
  it("verifies a genuine portable order", () => {
    const order = signOrder();
    const verified = verifyMakerOrder(parseBookOrderRow(openRow(order)), {
      now: NOW,
    });
    assert.notEqual(verified, null);
    assert.equal(verified?.orderDigest, computeOrderDigest(order.order, order.auth));
    assert.equal(verified?.fromAmount, BigInt(FROM_AMOUNT));
    assert.equal(verified?.toAmount, BigInt(TO_AMOUNT));
  });

  it("refuses a row whose amounts were rewritten under the signature", () => {
    const order = signOrder();
    const row = parseBookOrderRow({
      ...openRow(order),
      toAmount: (BigInt(TO_AMOUNT) + 1n).toString(),
      orderDigest: undefined,
    });
    assert.equal(verifyMakerOrder(row, { now: NOW }), null);
  });

  it("refuses a row whose id does not follow from the signed nonce", () => {
    const order = signOrder();
    const row = parseBookOrderRow({ ...openRow(order), id: "f".repeat(64) });
    assert.equal(verifyMakerOrder(row, { now: NOW }), null);
  });

  it("refuses a digest that contradicts the signed fields", () => {
    const order = signOrder();
    const row = parseBookOrderRow({
      ...openRow(order),
      orderDigest: `0x${"11".repeat(32)}`,
    });
    assert.equal(verifyMakerOrder(row, { now: NOW }), null);
  });

  it("refuses an expired proof unless recovery asks for it", () => {
    const order = signOrder({ issuedAt: NOW - 7200, expiresAt: NOW - 60 });
    const row = parseBookOrderRow(openRow(order));
    assert.equal(verifyMakerOrder(row, { now: NOW }), null);
    assert.notEqual(
      verifyMakerOrder(row, { now: NOW, allowExpired: true }),
      null,
    );
  });

  it("refuses a legacy unsigned row", () => {
    const order = signOrder();
    const { makerAuth: _auth, orderDigest: _digest, ...rest } = openRow(order);
    void _auth;
    void _digest;
    assert.equal(verifyMakerOrder(parseBookOrderRow(rest), { now: NOW }), null);
  });

  it("refuses a private or taker restricted row", () => {
    const order = signOrder();
    const row = parseBookOrderRow({
      ...openRow(order),
      visibility: "private",
      allowedTakerEth: TAKER_ETH,
    });
    assert.equal(verifyMakerOrder(row, { now: NOW }), null);
  });
});

describe("pre-funded orders", () => {
  it("verifies a listing whose escrow window is inside the protocol bounds", () => {
    const issuedAt = NOW - 60;
    const order = maker.signOrderV1(
      {
        direction: "eth->qrl",
        asset: "ETH",
        fromAmount: FROM_AMOUNT,
        toAmount: TO_AMOUNT,
        makerEthAccount: MAKER_ETH,
        makerQrlAccount: maker.address,
        prelock: {
          hashlock: PRELOCK_HASHLOCK,
          initiatorTimeout: issuedAt + 4 * 3600,
        },
      },
      { makerToken: randomBytes(32).toString("hex"), issuedAt },
    );
    const verified = verifyMakerOrder(parseBookOrderRow(prelockedRow(order)), {
      now: NOW,
    });
    assert.notEqual(verified, null);
    assert.equal(verified?.prelocked, true);
  });

  it("refuses a listing whose escrow window is too short", () => {
    const issuedAt = NOW - 60;
    const order = signRawOrder({
      prelock: { hashlock: PRELOCK_HASHLOCK, initiatorTimeout: issuedAt + 3600 },
      issuedAt,
      expiresAt: issuedAt + 1800,
    });
    assert.equal(
      verifyMakerOrder(parseBookOrderRow(prelockedRow(order)), { now: NOW }),
      null,
    );
  });

  it("refuses a listing whose escrow window is too long", () => {
    const issuedAt = NOW - 60;
    const order = signRawOrder({
      prelock: {
        hashlock: PRELOCK_HASHLOCK,
        initiatorTimeout: issuedAt + 96 * 3600,
      },
      issuedAt,
      expiresAt: issuedAt + 3600,
    });
    assert.equal(
      verifyMakerOrder(parseBookOrderRow(prelockedRow(order)), { now: NOW }),
      null,
    );
  });

  it("refuses a listing whose proof outlives its escrow", () => {
    const issuedAt = NOW - 60;
    const order = signRawOrder({
      prelock: {
        hashlock: PRELOCK_HASHLOCK,
        initiatorTimeout: issuedAt + 4 * 3600,
      },
      issuedAt,
      expiresAt: issuedAt + 5 * 3600,
    });
    assert.equal(
      verifyMakerOrder(parseBookOrderRow(prelockedRow(order)), { now: NOW }),
      null,
    );
  });

  it("blocks funding a late fill that leaves too little escrow runway", () => {
    const issuedAt = NOW - 60;
    const initiatorTimeout = issuedAt + 4 * 3600;
    const order = maker.signOrderV1(
      {
        direction: "eth->qrl",
        asset: "ETH",
        fromAmount: FROM_AMOUNT,
        toAmount: TO_AMOUNT,
        makerEthAccount: MAKER_ETH,
        makerQrlAccount: maker.address,
        prelock: { hashlock: PRELOCK_HASHLOCK, initiatorTimeout },
      },
      { makerToken: randomBytes(32).toString("hex"), issuedAt },
    );
    // The maker waits until its own escrow is nearly spent, which leaves the
    // taker a fraction of the runway the protocol requires.
    const fillIssuedAt = initiatorTimeout - 3600;
    const { signed: intent } = signIntent(order, fillIssuedAt);
    const fill = maker.signFillV1(
      {
        orderDigest: computeOrderDigest(order.order, order.auth),
        intentDigest: computeFillIntentDigest(intent.intent, intent.auth),
        takerEthAccount: intent.intent.takerEthAccount,
        takerQrlAccount: intent.intent.takerQrlAccount,
        releaseCommitment: intent.intent.releaseCommitment,
        hashlock: PRELOCK_HASHLOCK,
        initiatorTimeout,
        responderTimeout: fillIssuedAt + 1800,
      },
      {
        order,
        selectedIntent: {
          intentDigest: computeFillIntentDigest(intent.intent, intent.auth),
          intent: intent.intent,
          auth: intent.auth,
        },
        issuedAt: fillIssuedAt,
        respondBy: fillIssuedAt + 300,
      },
    );
    const row = {
      ...prelockedRow(order),
      status: "locking",
      takerEthAccount: fill.fill.takerEthAccount,
      takerQrlAccount: fill.fill.takerQrlAccount,
      responderTimeout: fill.fill.responderTimeout,
      fill: fill.fill,
      fillAuth: fill.auth,
      fillDigest: computeFillDigest(fill.fill, order.auth, fill.auth),
      selectedIntent: {
        intentDigest: computeFillIntentDigest(intent.intent, intent.auth),
        intent: intent.intent,
        auth: intent.auth,
        receivedAt: fillIssuedAt,
      },
    };
    assert.throws(
      () =>
        verifyMakerFill(
          parseBookOrderRow(row),
          recoveryFor(intent, order),
          { now: fillIssuedAt + 10 },
        ),
      FundingBlockedError,
    );
  });
});

describe("our own proposal", () => {
  it("verifies the proposal this client signed", () => {
    const order = signOrder();
    const { signed } = signIntent(order);
    assert.equal(
      verifyOwnIntent(
        signed,
        computeOrderDigest(order.order, order.auth),
        order.auth,
        { now: NOW },
      ),
      true,
    );
  });

  it("refuses an expired proposal unless settlement asks for it", () => {
    const order = signOrder({ issuedAt: NOW - 3600 });
    const { signed } = signIntent(order, NOW - 300);
    const digest = computeOrderDigest(order.order, order.auth);
    assert.equal(verifyOwnIntent(signed, digest, order.auth, { now: NOW }), false);
    assert.equal(
      verifyOwnIntent(signed, digest, order.auth, { now: NOW, allowExpired: true }),
      true,
    );
  });

  it("refuses a proposal signed for another order", () => {
    const order = signOrder();
    const other = signOrder({ issuedAt: NOW - 120 });
    const { signed } = signIntent(order);
    assert.equal(
      verifyOwnIntent(
        signed,
        computeOrderDigest(other.order, other.auth),
        other.auth,
        { now: NOW },
      ),
      false,
    );
  });

  it("compares proposals field by field", () => {
    const order = signOrder();
    const first = signIntent(order).signed;
    const second = signIntent(order).signed;
    assert.equal(sameSignedIntent(first, first), true);
    assert.equal(sameSignedIntent(first, second), false);
  });
});

describe("maker fill verification", () => {
  function setup(): {
    order: SignedOrderV1;
    intent: SignedFillIntentV1;
    fill: SignedFillV1;
    row: Record<string, unknown>;
  } {
    const order = signOrder();
    const { signed: intent } = signIntent(order);
    const fill = signFill(order, intent);
    return { order, intent, fill, row: lockingRow(order, intent, fill) };
  }

  it("authenticates a genuine terminal fill", () => {
    const { order, intent, row } = setup();
    const verified = verifyMakerFill(
      parseBookOrderRow(row),
      recoveryFor(intent, order),
      { now: NOW + 10 },
    );
    assert.notEqual(verified, null);
    assert.equal(verified?.signed.fill.hashlock, `0x${"12".repeat(32)}`);
  });

  it("returns nothing while the maker has published no fill", () => {
    const order = signOrder();
    const { signed: intent } = signIntent(order);
    assert.equal(
      verifyMakerFill(
        parseBookOrderRow(openRow(order)),
        recoveryFor(intent, order),
        { now: NOW },
      ),
      null,
    );
  });

  it("blocks funding once the proposal was released", () => {
    const { order, intent, row } = setup();
    assert.throws(
      () =>
        verifyMakerFill(
          parseBookOrderRow({ ...row, released: true }),
          recoveryFor(intent, order),
          { now: NOW + 10 },
        ),
      FundingBlockedError,
    );
  });

  it("blocks funding on equivocation evidence", () => {
    const { order, intent, row } = setup();
    assert.throws(
      () =>
        verifyMakerFill(
          parseBookOrderRow({
            ...row,
            equivocated: true,
            conflictDigests: [`0x${"ab".repeat(32)}`],
          }),
          recoveryFor(intent, order),
          { now: NOW + 10 },
        ),
      FundingBlockedError,
    );
  });

  it("blocks funding when the maker selected another proposal", () => {
    const { order, row } = setup();
    const other = signIntent(order, NOW + 1).signed;
    assert.throws(
      () =>
        verifyMakerFill(
          parseBookOrderRow(row),
          recoveryFor(other, order),
          { now: NOW + 10 },
        ),
      FundingBlockedError,
    );
  });

  it("blocks funding after the maker response deadline", () => {
    const { order, intent, row } = setup();
    assert.throws(
      () =>
        verifyMakerFill(parseBookOrderRow(row), recoveryFor(intent, order), {
          now: NOW + 5 + 301,
        }),
      /deadline passed/,
    );
  });

  it("blocks funding on a mismatched fill digest", () => {
    const { order, intent, row } = setup();
    assert.throws(
      () =>
        verifyMakerFill(
          parseBookOrderRow({ ...row, fillDigest: `0x${"cd".repeat(32)}` }),
          recoveryFor(intent, order),
          { now: NOW + 10 },
        ),
      /mismatched FillV2 digest/,
    );
  });

  it("blocks funding when the row contradicts its own fill", () => {
    const { order, intent, row } = setup();
    assert.throws(
      () =>
        verifyMakerFill(
          parseBookOrderRow({ ...row, responderTimeout: NOW + 10 }),
          recoveryFor(intent, order),
          { now: NOW + 10 },
        ),
      FundingBlockedError,
    );
  });

  it("blocks funding on a fill whose signature does not verify", () => {
    const { order, intent, fill, row } = setup();
    const tampered = {
      ...row,
      fillAuth: { ...fill.auth, nonce: `0x${"ee".repeat(32)}` },
    };
    assert.throws(
      () =>
        verifyMakerFill(parseBookOrderRow(tampered), recoveryFor(intent, order), {
          now: NOW + 10,
        }),
      FundingBlockedError,
    );
  });

  it("blocks funding on an incomplete locking row", () => {
    const { order, intent, row } = setup();
    const { selectedIntent: _drop, ...partial } = row;
    void _drop;
    assert.throws(
      () =>
        verifyMakerFill(parseBookOrderRow(partial), recoveryFor(intent, order), {
          now: NOW + 10,
        }),
      /incomplete FillV2/,
    );
  });
});

describe("maker cancellation", () => {
  it("authenticates a genuine cancellation", () => {
    const order = signOrder();
    const cancel = maker.signCancelV1(
      { orderDigest: computeOrderDigest(order.order, order.auth), reasonCode: 1 },
      {
        orderNonce: order.auth.nonce,
        expiresAt: order.auth.expiresAt,
        issuedAt: NOW,
      },
    );
    const row: BookOrderRow = parseBookOrderRow({
      ...openRow(order),
      status: "cancelled",
      cancelProof: cancel.cancel,
      cancelAuth: cancel.auth,
    });
    assert.equal(
      verifyMakerCancel(row, computeOrderDigest(order.order, order.auth), {
        now: NOW,
      }),
      true,
    );
  });

  it("refuses a cancellation for another order", () => {
    const order = signOrder();
    const other = signOrder({ issuedAt: NOW - 120 });
    const cancel = maker.signCancelV1(
      { orderDigest: computeOrderDigest(other.order, other.auth), reasonCode: 1 },
      {
        orderNonce: other.auth.nonce,
        expiresAt: other.auth.expiresAt,
        issuedAt: NOW,
      },
    );
    const row = parseBookOrderRow({
      ...openRow(order),
      status: "cancelled",
      cancelProof: cancel.cancel,
      cancelAuth: cancel.auth,
    });
    assert.equal(
      verifyMakerCancel(row, computeOrderDigest(order.order, order.auth), {
        now: NOW,
      }),
      false,
    );
  });
});
