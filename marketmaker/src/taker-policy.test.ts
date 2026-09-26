// Gates that keep a scripted taker's funds safe, pinned with node:test.
// IO-free: decideTaker() is the single choke point every irreversible
// taker action goes through.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  NATIVE_TOKEN,
  QRL_NATIVE_TOKEN,
  SwapStatus,
  type LegState,
} from "./htlc.js";
import {
  checkMakerLock,
  checkOwnLock,
  decideTaker,
  expectedToken,
  initiatorLeg,
  responderLeg,
  takeBoundsIssue,
  takerLegPlans,
  type TakerDecideInput,
  type TakerDecisionRecord,
} from "./taker-policy.js";

const NOW = 1_800_000_000;
const T1 = NOW + 7200;
const T2 = NOW + 3600;
const MAKER_ETH = `0x${"a".repeat(40)}`;
const MAKER_QRL = `Q${"b".repeat(128)}`;
const TAKER_ETH = `0x${"c".repeat(40)}`;
const TAKER_QRL = `Q${"d".repeat(128)}`;
const HASHLOCK = `0x${"12".repeat(32)}`;
const PREIMAGE = `0x${"34".repeat(32)}`;
const ZERO32 = `0x${"0".repeat(64)}`;
const RECEIVE = 2n * 10n ** 16n;
const PAY = 2n * 10n ** 18n;

// eth->qrl: the maker escrows ETH, this taker escrows QRL.
const PLANS = takerLegPlans({
  direction: "eth->qrl",
  asset: "ETH",
  fromAmount: RECEIVE,
  toAmount: PAY,
  makerEthAccount: MAKER_ETH,
  makerQrlAccount: MAKER_QRL,
  takerEthAccount: TAKER_ETH,
  takerQrlAccount: TAKER_QRL,
  initiatorTimeout: T1,
  responderTimeout: T2,
});

const OUR_QRL_HEX = `0x${TAKER_QRL.slice(1)}`;

function leg(overrides: Partial<LegState> = {}): LegState {
  return {
    status: SwapStatus.None,
    initiator: NATIVE_TOKEN,
    recipient: NATIVE_TOKEN,
    token: NATIVE_TOKEN,
    amount: 0n,
    timeout: 0,
    preimage: ZERO32,
    ...overrides,
  };
}

/** The maker's honest escrow on the Ethereum leg. */
function makerLock(overrides: Partial<LegState> = {}): LegState {
  return leg({
    status: SwapStatus.Open,
    initiator: MAKER_ETH,
    recipient: TAKER_ETH,
    token: NATIVE_TOKEN,
    amount: RECEIVE,
    timeout: T1,
    ...overrides,
  });
}

/** Our own honest escrow on the QRL leg. */
function ourLock(overrides: Partial<LegState> = {}): LegState {
  return leg({
    status: SwapStatus.Open,
    initiator: OUR_QRL_HEX,
    recipient: `0x${MAKER_QRL.slice(1)}`,
    token: QRL_NATIVE_TOKEN,
    amount: PAY,
    timeout: T2,
    ...overrides,
  });
}

function record(overrides: Partial<TakerDecisionRecord> = {}): TakerDecisionRecord {
  return {
    fillAcknowledged: true,
    intentSubmittedAt: NOW - 30,
    lockSentAt: null,
    claimSentAt: null,
    refundSentAt: null,
    releaseSentAt: null,
    ...overrides,
  };
}

function input(overrides: Partial<TakerDecideInput> = {}): TakerDecideInput {
  return {
    record: record(),
    bookStatus: "locking",
    released: false,
    cancelled: false,
    fill: {
      hashlock: HASHLOCK,
      initiatorTimeout: T1,
      responderTimeout: T2,
      respondBy: NOW + 300,
    },
    plans: PLANS,
    iState: makerLock(),
    iConfirmed: makerLock(),
    rState: leg(),
    ourResponderAddress: TAKER_QRL,
    intentPending: null,
    abandonRequested: false,
    nowS: NOW,
    resendAfterS: 240,
    claimSafetyS: 600,
    lockRunwayS: 900,
    claimSubmitMarginS: 240,
    ...overrides,
  };
}

describe("taker leg plans", () => {
  it("routes each leg to the account that must be paid", () => {
    assert.equal(initiatorLeg("eth->qrl"), "eth");
    assert.equal(responderLeg("eth->qrl"), "qrl");
    assert.equal(PLANS.initiator.recipient, TAKER_ETH);
    assert.equal(PLANS.responder.recipient, MAKER_QRL);
    assert.equal(PLANS.initiator.amount, RECEIVE);
    assert.equal(PLANS.responder.amount, PAY);
  });

  it("resolves the expected escrow asset from the local registry", () => {
    assert.equal(expectedToken("qrl", "USDC"), QRL_NATIVE_TOKEN);
    assert.equal(expectedToken("eth", "ETH"), NATIVE_TOKEN);
    assert.notEqual(expectedToken("eth", "USDC"), NATIVE_TOKEN);
  });
});

describe("maker escrow verification", () => {
  it("accepts an escrow matching every agreed field", () => {
    assert.deepEqual(checkMakerLock(makerLock(), PLANS.initiator, T2, 600), {
      state: "ok",
    });
  });

  it("refuses an escrow holding the wrong asset", () => {
    const wrongToken = makerLock({ token: `0x${"9".repeat(40)}` });
    const check = checkMakerLock(wrongToken, PLANS.initiator, T2, 600);
    assert.equal(check.state, "mismatch");
  });

  it("refuses an escrow paying someone else", () => {
    const check = checkMakerLock(
      makerLock({ recipient: `0x${"e".repeat(40)}` }),
      PLANS.initiator,
      T2,
      600,
    );
    assert.equal(check.state, "mismatch");
  });

  it("refuses an escrow holding the wrong amount", () => {
    const check = checkMakerLock(
      makerLock({ amount: RECEIVE - 1n }),
      PLANS.initiator,
      T2,
      600,
    );
    assert.equal(check.state, "mismatch");
  });

  it("refuses an escrow whose own timeout leaves too little claim window", () => {
    const check = checkMakerLock(
      makerLock({ timeout: T2 + 599 }),
      PLANS.initiator,
      T2,
      600,
    );
    assert.equal(check.state, "mismatch");
    assert.match(
      check.state === "mismatch" ? check.issue : "",
      /claim window/,
    );
  });

  it("separates an unassigned pre-funded escrow from a mismatch", () => {
    const check = checkMakerLock(
      makerLock({ recipient: NATIVE_TOKEN }),
      PLANS.initiator,
      T2,
      600,
    );
    assert.equal(check.state, "awaiting-assign");
  });

  it("refuses to treat an unreadable snapshot as verified", () => {
    assert.deepEqual(checkMakerLock(null, PLANS.initiator, T2, 600), {
      state: "absent",
    });
  });
});

describe("own escrow classification", () => {
  it("recognizes our own matching escrow", () => {
    assert.deepEqual(checkOwnLock(ourLock(), PLANS.responder, TAKER_QRL), {
      state: "ours",
    });
  });

  it("refuses to adopt a third party escrow on the same hashlock", () => {
    const squatted = ourLock({ initiator: `0x${"7".repeat(128)}` });
    const check = checkOwnLock(squatted, PLANS.responder, TAKER_QRL);
    assert.equal(check.state, "foreign");
  });

  it("refuses our own escrow when it carries the wrong terms", () => {
    const check = checkOwnLock(
      ourLock({ amount: PAY - 1n }),
      PLANS.responder,
      TAKER_QRL,
    );
    assert.equal(check.state, "foreign");
  });
});

describe("decideTaker before a fill exists", () => {
  it("proposes when no live proposal exists", () => {
    const verdict = decideTaker(
      input({
        fill: null,
        bookStatus: "open",
        record: record({ fillAcknowledged: false, intentSubmittedAt: null }),
        iState: null,
        iConfirmed: null,
      }),
    );
    assert.equal(verdict.decision, "propose");
  });

  it("waits while our proposal is still live", () => {
    const verdict = decideTaker(
      input({
        fill: null,
        bookStatus: "open",
        record: record({ fillAcknowledged: false }),
        intentPending: { expiresAt: NOW + 60 },
        iState: null,
        iConfirmed: null,
      }),
    );
    assert.equal(verdict.decision, "wait");
  });

  it("proposes again once our proposal expired unfilled", () => {
    const verdict = decideTaker(
      input({
        fill: null,
        bookStatus: "open",
        record: record({ fillAcknowledged: false }),
        intentPending: { expiresAt: NOW - 1 },
        iState: null,
        iConfirmed: null,
      }),
    );
    assert.equal(verdict.decision, "propose");
  });

  it("gives up when the maker filled a different proposal", () => {
    const verdict = decideTaker(
      input({
        fill: null,
        bookStatus: "locking",
        record: record({ fillAcknowledged: false }),
        iState: null,
        iConfirmed: null,
      }),
    );
    assert.equal(verdict.decision, "abort");
  });

  it("gives up on a cancelled order while nothing is exposed", () => {
    const verdict = decideTaker(
      input({ fill: null, bookStatus: "cancelled", cancelled: true }),
    );
    assert.equal(verdict.decision, "abort");
  });

  it("gives up when the order left the book", () => {
    const verdict = decideTaker(input({ fill: null, bookStatus: "gone" }));
    assert.equal(verdict.decision, "abort");
  });

  it("gives up when our proposal was released", () => {
    const verdict = decideTaker(input({ fill: null, released: true }));
    assert.equal(verdict.decision, "abort");
  });

  it("releases a submitted proposal when the operator abandons the take", () => {
    const verdict = decideTaker(
      input({
        fill: null,
        bookStatus: "open",
        abandonRequested: true,
        record: record({ fillAcknowledged: false }),
      }),
    );
    assert.equal(verdict.decision, "release");
  });
});

describe("decideTaker funding gates", () => {
  it("funds our leg once the maker escrow verified at depth", () => {
    const verdict = decideTaker(input());
    assert.equal(verdict.decision, "lock");
  });

  it("never funds without a durable authenticated FillV2", () => {
    const verdict = decideTaker(
      input({ record: record({ fillAcknowledged: false }) }),
    );
    assert.equal(verdict.decision, "wait");
  });

  it("never funds against an escrow that mismatches any field", () => {
    for (const wrong of [
      makerLock({ token: `0x${"9".repeat(40)}` }),
      makerLock({ recipient: `0x${"e".repeat(40)}` }),
      makerLock({ amount: RECEIVE + 1n }),
      makerLock({ timeout: T2 + 10 }),
    ]) {
      const verdict = decideTaker(input({ iConfirmed: wrong, iState: wrong }));
      assert.equal(verdict.decision, "abort");
      assert.match(verdict.reason, /refusing to fund/);
    }
  });

  it("never funds on an unconfirmed escrow visible only at the head", () => {
    const verdict = decideTaker(input({ iConfirmed: null }));
    assert.equal(verdict.decision, "wait");
  });

  it("never funds when our own deadline leaves too little runway", () => {
    const verdict = decideTaker(input({ nowS: T2 - 899 }));
    assert.equal(verdict.decision, "abort");
    assert.match(verdict.reason, /runway/);
  });

  it("gives up after a release landed", () => {
    const verdict = decideTaker(input({ released: true }));
    assert.equal(verdict.decision, "abort");
  });

  it("stops funding when a release lands after our lock attempt", () => {
    const verdict = decideTaker(
      input({ released: true, record: record({ lockSentAt: NOW - 10 }) }),
    );
    assert.notEqual(verdict.decision, "lock");
  });

  it("never funds twice while a lock send is still settling", () => {
    const verdict = decideTaker(
      input({ record: record({ lockSentAt: NOW - 10 }) }),
    );
    assert.equal(verdict.decision, "wait");
  });

  it("retries a lock whose effect never landed", () => {
    const verdict = decideTaker(
      input({ record: record({ lockSentAt: NOW - 241 }) }),
    );
    assert.equal(verdict.decision, "lock");
  });

  it("decides nothing while our own leg cannot be read", () => {
    const verdict = decideTaker(input({ rState: null }));
    assert.equal(verdict.decision, "wait");
  });

  it("gives up when a stranger squatted our leg", () => {
    const verdict = decideTaker(
      input({ rState: ourLock({ initiator: `0x${"7".repeat(128)}` }) }),
    );
    assert.equal(verdict.decision, "abort");
  });
});

describe("decideTaker settlement", () => {
  it("waits for the reveal once our escrow is on chain", () => {
    const verdict = decideTaker(
      input({ rState: ourLock(), record: record({ lockSentAt: NOW - 300 }) }),
    );
    assert.equal(verdict.decision, "wait");
  });

  it("claims as soon as the maker's claim published the preimage", () => {
    const verdict = decideTaker(
      input({
        rState: ourLock({ status: SwapStatus.Claimed, preimage: PREIMAGE }),
        record: record({ lockSentAt: NOW - 300 }),
      }),
    );
    assert.equal(verdict.decision, "claim");
    assert.equal(verdict.revealedPreimage, PREIMAGE);
  });

  it("does not claim past the maker escrow's own deadline", () => {
    const verdict = decideTaker(
      input({
        nowS: T1 + 1,
        rState: ourLock({ status: SwapStatus.Claimed, preimage: PREIMAGE }),
        record: record({ lockSentAt: NOW - 300 }),
      }),
    );
    assert.notEqual(verdict.decision, "claim");
  });

  it("spaces claim retries", () => {
    const verdict = decideTaker(
      input({
        rState: ourLock({ status: SwapStatus.Claimed, preimage: PREIMAGE }),
        record: record({ lockSentAt: NOW - 300, claimSentAt: NOW - 10 }),
      }),
    );
    assert.notEqual(verdict.decision, "claim");
  });

  it("treats an escrow already claimed for us as settled", () => {
    const verdict = decideTaker(
      input({
        iState: makerLock({ status: SwapStatus.Claimed, preimage: PREIMAGE }),
        rState: ourLock({ status: SwapStatus.Claimed, preimage: PREIMAGE }),
        record: record({ lockSentAt: NOW - 300, claimSentAt: NOW - 300 }),
      }),
    );
    assert.equal(verdict.decision, "finish");
  });

  it("refunds our escrow after its own on-chain timeout", () => {
    const verdict = decideTaker(
      input({
        nowS: T2 + 1,
        rState: ourLock(),
        iState: makerLock(),
        iConfirmed: makerLock(),
        record: record({ lockSentAt: NOW - 300 }),
      }),
    );
    assert.equal(verdict.decision, "refund");
  });

  it("does not refund before the escrow's own timeout", () => {
    const verdict = decideTaker(
      input({
        nowS: T2 - 1,
        rState: ourLock(),
        record: record({ lockSentAt: NOW - 300 }),
      }),
    );
    assert.notEqual(verdict.decision, "refund");
  });

  it("spaces refund retries", () => {
    const verdict = decideTaker(
      input({
        nowS: T2 + 1,
        rState: ourLock(),
        record: record({ lockSentAt: NOW - 300, refundSentAt: T2 }),
      }),
    );
    assert.notEqual(verdict.decision, "refund");
  });

  it("stops watching once our leg settled and the maker escrow expired", () => {
    const verdict = decideTaker(
      input({
        nowS: T1 + 1,
        iState: makerLock(),
        iConfirmed: makerLock(),
        rState: ourLock({ status: SwapStatus.Refunded }),
        record: record({ lockSentAt: NOW - 300, refundSentAt: T2 }),
      }),
    );
    assert.equal(verdict.decision, "finish");
  });

  it("stops claiming inside the transaction margin of the deadline", () => {
    const verdict = decideTaker(
      input({
        nowS: T1 - 10,
        rState: ourLock({ status: SwapStatus.Claimed, preimage: PREIMAGE }),
        record: record({ lockSentAt: NOW - 300 }),
      }),
    );
    assert.notEqual(verdict.decision, "claim");
  });

  it("finishes after our refund and the maker's", () => {
    const verdict = decideTaker(
      input({
        nowS: T1 + 10,
        iState: makerLock({ status: SwapStatus.Refunded }),
        iConfirmed: makerLock({ status: SwapStatus.Refunded }),
        rState: ourLock({ status: SwapStatus.Refunded }),
        record: record({ lockSentAt: NOW - 300, refundSentAt: T2 }),
      }),
    );
    assert.equal(verdict.decision, "finish");
  });

  it("keeps settling through a book outage once funds are exposed", () => {
    const verdict = decideTaker(
      input({
        bookStatus: "gone",
        released: true,
        cancelled: true,
        rState: ourLock({ status: SwapStatus.Claimed, preimage: PREIMAGE }),
        record: record({ lockSentAt: NOW - 300 }),
      }),
    );
    assert.equal(verdict.decision, "claim");
  });

  it("gives up when the responder window closed with nothing exposed", () => {
    const verdict = decideTaker(
      input({
        nowS: T2 + 1,
        iState: leg(),
        iConfirmed: leg(),
        rState: leg(),
      }),
    );
    assert.equal(verdict.decision, "abort");
  });
});

describe("resume is idempotent at every step", () => {
  const steps: { name: string; patch: Partial<TakerDecideInput>; expect: string }[] = [
    {
      name: "before proposing",
      patch: {
        fill: null,
        bookStatus: "open",
        record: record({ fillAcknowledged: false, intentSubmittedAt: null }),
        iState: null,
        iConfirmed: null,
      },
      expect: "propose",
    },
    {
      name: "after proposing",
      patch: {
        fill: null,
        bookStatus: "open",
        record: record({ fillAcknowledged: false }),
        intentPending: { expiresAt: NOW + 60 },
        iState: null,
        iConfirmed: null,
      },
      expect: "wait",
    },
    { name: "after the fill authenticated", patch: {}, expect: "lock" },
    {
      name: "after our escrow landed",
      patch: { rState: ourLock(), record: record({ lockSentAt: NOW - 300 }) },
      expect: "wait",
    },
    {
      name: "after the reveal",
      patch: {
        rState: ourLock({ status: SwapStatus.Claimed, preimage: PREIMAGE }),
        record: record({ lockSentAt: NOW - 300 }),
      },
      expect: "claim",
    },
    {
      name: "after our claim",
      patch: {
        iState: makerLock({ status: SwapStatus.Claimed, preimage: PREIMAGE }),
        rState: ourLock({ status: SwapStatus.Claimed, preimage: PREIMAGE }),
        record: record({ lockSentAt: NOW - 300, claimSentAt: NOW - 300 }),
      },
      expect: "finish",
    },
  ];

  for (const step of steps) {
    it(`repeats the same decision ${step.name}`, () => {
      const first = decideTaker(input(step.patch));
      const second = decideTaker(input(step.patch));
      assert.equal(first.decision, step.expect);
      assert.equal(second.decision, step.expect);
    });
  }
});

describe("take bounds", () => {
  const base = {
    payAmount: PAY,
    receiveAmount: RECEIVE,
    maxIn: null,
    minOut: null,
    payBalance: PAY,
    nativePayLeg: false,
    gasBalance: 10n ** 18n,
    gasReserve: 10n ** 15n,
    orderExpiresAt: NOW + 3600,
    nowS: NOW,
    minOrderRunwayS: 900,
  };

  it("accepts a take inside every bound", () => {
    assert.equal(takeBoundsIssue(base), null);
  });

  it("refuses to pay more than --max-in", () => {
    assert.match(
      takeBoundsIssue({ ...base, maxIn: PAY - 1n }) ?? "",
      /max-in/,
    );
  });

  it("refuses to receive less than --min-out", () => {
    assert.match(
      takeBoundsIssue({ ...base, minOut: RECEIVE + 1n }) ?? "",
      /min-out/,
    );
  });

  it("refuses an order whose proof expires too soon", () => {
    assert.match(
      takeBoundsIssue({ ...base, orderExpiresAt: NOW + 60 }) ?? "",
      /expires too soon/,
    );
  });

  it("refuses a take the funding account cannot cover", () => {
    assert.match(
      takeBoundsIssue({ ...base, payBalance: PAY - 1n }) ?? "",
      /holds less/,
    );
  });

  it("refuses a native take that cannot cover its own gas reserve", () => {
    assert.match(
      takeBoundsIssue({ ...base, nativePayLeg: true, payBalance: PAY }) ?? "",
      /gas reserve/,
    );
    assert.equal(
      takeBoundsIssue({
        ...base,
        nativePayLeg: true,
        payBalance: PAY + base.gasReserve,
      }),
      null,
    );
  });

  it("refuses a take with no gas headroom", () => {
    assert.match(
      takeBoundsIssue({ ...base, gasBalance: 0n }) ?? "",
      /gas/,
    );
  });
});
