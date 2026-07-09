// Gates that keep the maker's funds safe, pinned with node:test. IO-free:
// decide() is the single choke point every irreversible action goes
// through.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { SwapStatus, type LegState } from "./htlc.js";
import { decide, levelQuote, shouldPost, type DecideInput, type ManagedOrder } from "./policy.js";

const NOW = 1_800_000_000;
const T1 = NOW + 7200;
const T2 = NOW + 3600;
const MY_QRL = "Qcccccccccccccccccccccccccccccccccccccccc";
const TAKER_ETH = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const AMOUNT = 2n * 10n ** 18n;
const ZERO32 = `0x${"0".repeat(64)}`;

function managed(overrides: Partial<ManagedOrder> = {}): ManagedOrder {
  return {
    id: "abcdef0123456789",
    token: "t",
    direction: "eth->qrl",
    level: 0,
    quotedMidMilli: "100000",
    fromAmount: (2n * 10n ** 16n).toString(),
    toAmount: AMOUNT.toString(),
    preimage: `0x${"34".repeat(32)}`,
    hashlock: `0x${"12".repeat(32)}`,
    initiatorTimeout: T1,
    responderTimeout: T2,
    takerEthAccount: TAKER_ETH,
    takerQrlAccount: `Q${"d".repeat(40)}`,
    lockSentAt: null,
    claimSentAt: null,
    refundSentAt: null,
    createdAt: NOW - 120,
    ...overrides,
  };
}

const leg = (status: number, overrides: Partial<LegState> = {}): LegState => ({
  status: status as LegState["status"],
  initiator: TAKER_ETH,
  recipient: `0x${MY_QRL.slice(1)}`,
  amount: AMOUNT,
  timeout: T2,
  preimage: ZERO32,
  ...overrides,
});

function input(overrides: Partial<DecideInput> = {}): DecideInput {
  return {
    bookStatus: "locking",
    released: false,
    managed: managed(),
    iState: leg(SwapStatus.None),
    rState: null,
    rConfirmed: null,
    expectedRecipient: MY_QRL,
    expectedAmountWei: AMOUNT,
    nowS: NOW,
    resendAfterS: 240,
    claimSafetyS: 600,
    ...overrides,
  };
}

describe("listing lifecycle", () => {
  it("waits while listed and announces when taken", () => {
    assert.equal(decide(input({ bookStatus: "open" })), "wait");
    assert.equal(decide(input({ bookStatus: "accepted" })), "announce");
  });

  it("forgets an order that vanished before any funds moved", () => {
    assert.equal(decide(input({ bookStatus: "gone", iState: leg(SwapStatus.None) })), "abort");
    assert.equal(decide(input({ bookStatus: "cancelled", iState: leg(SwapStatus.None) })), "abort");
  });

  it("keeps managing a vanished order once funds are on chain", () => {
    const x = input({ bookStatus: "gone", iState: leg(SwapStatus.Open) });
    assert.notEqual(decide(x), "abort");
  });
});

describe("locking our leg", () => {
  it("locks after announcing", () => {
    assert.equal(decide(input()), "lock");
  });

  it("does not lock when the responder window is nearly gone, and drops at expiry", () => {
    assert.equal(decide(input({ nowS: T2 - 300 })), "wait");
    assert.equal(decide(input({ nowS: T2 + 10 })), "abort");
  });

  it("does not resend a fresh lock, but retries a stale one", () => {
    assert.equal(decide(input({ managed: managed({ lockSentAt: NOW - 60 }) })), "wait");
    assert.equal(decide(input({ managed: managed({ lockSentAt: NOW - 600 }) })), "lock");
  });

  it("fails closed on an RPC gap", () => {
    assert.equal(decide(input({ iState: null })), "wait");
  });
});

describe("taker release", () => {
  it("aborts a released take before any funds moved (never locks into the void)", () => {
    assert.equal(decide(input({ released: true })), "abort");
  });

  it("never re-locks a released take even after a stale lock attempt", () => {
    const x = input({ released: true, managed: managed({ lockSentAt: NOW - 600 }) });
    assert.equal(decide(x), "wait");
  });

  it("still refunds our locked leg at t1 after a release", () => {
    const x = input({ released: true, iState: leg(SwapStatus.Open), nowS: T1 });
    assert.equal(decide(x), "refund");
  });

  it("still claims a valid taker lock after a release (discard-after-lock)", () => {
    const locked = leg(SwapStatus.Open);
    const x = input({
      released: true,
      iState: leg(SwapStatus.Open),
      rState: locked,
      rConfirmed: locked,
    });
    assert.equal(decide(x), "claim");
  });
});

describe("claiming the taker's lock (irreversible)", () => {
  const lockedInputs = (rConfirmed: LegState | null, rState: LegState | null = leg(SwapStatus.Open)) =>
    input({ iState: leg(SwapStatus.Open), rState, rConfirmed });

  it("claims a depth-confirmed, exactly-as-agreed lock", () => {
    assert.equal(decide(lockedInputs(leg(SwapStatus.Open))), "claim");
  });

  it("never claims on head-only state (awaiting depth)", () => {
    assert.equal(decide(lockedInputs(null)), "wait");
    assert.equal(decide(lockedInputs(leg(SwapStatus.None))), "wait");
  });

  it("never claims a lock paying someone else", () => {
    const bad = leg(SwapStatus.Open, { recipient: TAKER_ETH });
    assert.equal(decide(lockedInputs(bad, bad)), "wait");
  });

  it("never claims a short-paying lock", () => {
    const bad = leg(SwapStatus.Open, { amount: AMOUNT - 1n });
    assert.equal(decide(lockedInputs(bad, bad)), "wait");
  });

  it("stops claiming inside the safety margin of the responder timeout", () => {
    const x = lockedInputs(leg(SwapStatus.Open));
    assert.equal(decide({ ...x, nowS: T2 - 300 }), "wait");
  });

  it("accepts hex/Q-prefix and case differences in the recipient", () => {
    const shouted = leg(SwapStatus.Open, { recipient: `0x${MY_QRL.slice(1).toUpperCase()}` });
    assert.equal(decide(lockedInputs(shouted, shouted)), "claim");
  });
});

describe("refund and settlement", () => {
  it("refunds an open lock only once past our timeout", () => {
    assert.equal(decide(input({ iState: leg(SwapStatus.Open), nowS: T1 })), "refund");
    assert.equal(decide(input({ iState: leg(SwapStatus.Open), nowS: T1 - 10 })), "wait");
  });

  it("settles when both legs are terminal", () => {
    const x = input({
      iState: leg(SwapStatus.Claimed),
      rState: leg(SwapStatus.Claimed),
      nowS: T1 + 100,
    });
    assert.equal(decide(x), "finish");
  });

  it("settles a refunded swap the taker never joined", () => {
    const x = input({
      iState: leg(SwapStatus.Refunded),
      rState: leg(SwapStatus.None),
      nowS: T1 + 100,
    });
    assert.equal(decide(x), "finish");
  });

  it("keeps waiting while the taker can still claim our leg", () => {
    const x = input({
      iState: leg(SwapStatus.Open),
      rState: leg(SwapStatus.Claimed),
      nowS: T2 + 100,
    });
    assert.equal(decide(x), "wait");
  });
});

describe("price ladder", () => {
  const base = {
    baseEthWei: 2n * 10n ** 16n, // 0.02 ETH
    midPriceMilli: 100_000n, // 100 QRL/ETH
    stepBps: 50n, // 0.5% per rung
  };
  it("asks quote above mid, scaling price and size per rung", () => {
    const l0 = levelQuote({ ...base, direction: "eth->qrl", level: 0 });
    // 0.02 ETH at 100.5 QRL/ETH
    assert.equal(l0.fromAmount, (2n * 10n ** 16n).toString());
    assert.equal(l0.toAmount, (201n * 10n ** 16n).toString());
    const l1 = levelQuote({ ...base, direction: "eth->qrl", level: 1 });
    // 0.04 ETH at 101 QRL/ETH
    assert.equal(l1.fromAmount, (4n * 10n ** 16n).toString());
    assert.equal(l1.toAmount, (404n * 10n ** 16n).toString());
  });

  it("bids quote below mid", () => {
    const l0 = levelQuote({ ...base, direction: "qrl->eth", level: 0 });
    // gives 1.99 QRL, wants 0.02 ETH (99.5 QRL/ETH)
    assert.equal(l0.fromAmount, (199n * 10n ** 16n).toString());
    assert.equal(l0.toAmount, (2n * 10n ** 16n).toString());
  });

  it("keeps a positive spread: best ask above best bid", () => {
    const ask = levelQuote({ ...base, direction: "eth->qrl", level: 0 });
    const bid = levelQuote({ ...base, direction: "qrl->eth", level: 0 });
    assert.ok(BigInt(ask.toAmount) > BigInt(bid.fromAmount));
  });
});

describe("refill policy", () => {
  const base = {
    direction: "eth->qrl" as const,
    myOpenCount: 0,
    ordersPerDirection: 2,
    inflightCount: 0,
    maxInflight: 2,
    balanceWei: 10n ** 18n,
    reserveWei: 5n * 10n ** 16n,
    orderWei: 2n * 10n ** 16n,
  };

  it("posts while under target with inventory", () => {
    assert.equal(shouldPost(base), true);
  });

  it("stops at the listing target", () => {
    assert.equal(shouldPost({ ...base, myOpenCount: 2 }), false);
  });

  it("stops when in-flight exposure is maxed (griefing cap)", () => {
    assert.equal(shouldPost({ ...base, inflightCount: 2 }), false);
  });

  it("stops when inventory would dip into the reserve", () => {
    assert.equal(shouldPost({ ...base, balanceWei: 6n * 10n ** 16n }), false);
  });
});
