// The full role x chain-state matrix for the swap state machine. Every
// scenario here is one the UI must get right with real funds locked, so
// assertions pin exact gating behavior, not implementation details.

import { describe, expect, it } from "vitest";
import { CLAIM_MARGIN_S } from "../config";
import { SwapStatus, type LegState } from "./htlc";
import type { ActiveSwap, SwapRole } from "./activeSwap";
import { ZERO32, deriveSwapMachine, sameAddr, type LegStates } from "./swapMachine";

const MAKER_ETH = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TAKER_ETH = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const MAKER_QRL = "Qcccccccccccccccccccccccccccccccccccccccc";
const TAKER_QRL = "Qdddddddddddddddddddddddddddddddddddddddd";
const HASHLOCK = `0x${"12".repeat(32)}`;
const PREIMAGE = `0x${"34".repeat(32)}`;

const NOW = 1_800_000_000;
const I_TIMEOUT = NOW + 7200;
const R_TIMEOUT = NOW + 3600;

const ETH_AMOUNT = 10n ** 18n; // 1 ETH on the initiator (eth) leg
const QRL_AMOUNT = 5n * 10n ** 18n; // 5 QRL on the responder (qrl) leg

function swapFor(role: SwapRole, overrides: Partial<ActiveSwap> = {}): ActiveSwap {
  return {
    role,
    orderId: role === "sandbox" ? null : "order-1",
    direction: "eth->qrl",
    fromAmount: ETH_AMOUNT.toString(),
    toAmount: QRL_AMOUNT.toString(),
    makerEthAccount: MAKER_ETH,
    makerQrlAccount: MAKER_QRL,
    takerEthAccount: TAKER_ETH,
    takerQrlAccount: TAKER_QRL,
    preimage: role === "taker" ? null : PREIMAGE,
    hashlock: HASHLOCK,
    initiatorTimeout: I_TIMEOUT,
    responderTimeout: R_TIMEOUT,
    createdAt: NOW - 60,
    ...overrides,
  };
}

const none = (): LegState => ({
  status: SwapStatus.None,
  initiator: ZERO32.slice(0, 42),
  recipient: ZERO32.slice(0, 42),
  amount: 0n,
  timeout: 0,
  preimage: ZERO32,
});

/** The maker's initiator-leg (eth) lock exactly as agreed. */
const iOpen = (overrides: Partial<LegState> = {}): LegState => ({
  status: SwapStatus.Open,
  initiator: MAKER_ETH,
  recipient: TAKER_ETH,
  amount: ETH_AMOUNT,
  timeout: I_TIMEOUT,
  preimage: ZERO32,
  ...overrides,
});

/** The taker's responder-leg (qrl) lock exactly as agreed. */
const rOpen = (overrides: Partial<LegState> = {}): LegState => ({
  status: SwapStatus.Open,
  initiator: `0x${TAKER_QRL.slice(1)}`,
  recipient: `0x${MAKER_QRL.slice(1)}`,
  amount: QRL_AMOUNT,
  timeout: R_TIMEOUT,
  preimage: ZERO32,
  ...overrides,
});

const claimed = (base: LegState, preimage = PREIMAGE): LegState => ({
  ...base,
  status: SwapStatus.Claimed,
  preimage,
});

function derive(
  role: SwapRole,
  legs: LegStates,
  confirmed: LegStates,
  opts: { nowS?: number; swap?: Partial<ActiveSwap> } = {},
) {
  const machine = deriveSwapMachine({
    swap: swapFor(role, opts.swap ?? {}),
    legs,
    confirmed,
    nowS: opts.nowS ?? NOW,
  });
  if (!machine) throw new Error("machine unexpectedly null");
  return machine;
}

describe("guards", () => {
  it("returns null while the hashlock or timeouts are missing", () => {
    for (const swap of [
      swapFor("taker", { hashlock: null }),
      swapFor("maker", { initiatorTimeout: null }),
      swapFor("maker", { responderTimeout: null }),
    ]) {
      expect(deriveSwapMachine({ swap, legs: {}, confirmed: {}, nowS: NOW })).toBeNull();
    }
  });
});

describe("role ownership", () => {
  it("maker signs steps 1 and 3, taker signs 2 and 4, sandbox signs all", () => {
    const owns = (role: SwapRole) =>
      derive(role, { eth: none(), qrl: none() }, {}).steps.map((s) => s.own);
    expect(owns("maker")).toEqual([true, false, true, false]);
    expect(owns("taker")).toEqual([false, true, false, true]);
    expect(owns("sandbox")).toEqual([true, true, true, true]);
  });

  it("legs follow the direction: eth->qrl initiates on eth, qrl->eth on qrl", () => {
    const fwd = derive("sandbox", { eth: none(), qrl: none() }, {});
    expect([fwd.iLeg, fwd.rLeg]).toEqual(["eth", "qrl"]);
    const machine = deriveSwapMachine({
      swap: swapFor("sandbox", { direction: "qrl->eth" }),
      legs: { eth: none(), qrl: none() },
      confirmed: {},
      nowS: NOW,
    });
    expect([machine?.iLeg, machine?.rLeg]).toEqual(["qrl", "eth"]);
  });
});

describe("step 1: initiator lock", () => {
  it("is the only runnable step on a fresh swap", () => {
    const m = derive("maker", { eth: none(), qrl: none() }, {});
    expect(m.steps.map((s) => s.canRun)).toEqual([true, false, false, false]);
  });

  it("does not enable before chain state has loaded", () => {
    const m = derive("maker", {}, {});
    expect(m.steps[0].canRun).toBe(false);
  });

  it("is done once the leg leaves None", () => {
    const m = derive("maker", { eth: iOpen(), qrl: none() }, {});
    expect(m.steps[0].done).toBe(true);
    expect(m.steps[0].canRun).toBe(false);
  });
});

describe("step 2: responder lock (taker's irreversible commit)", () => {
  it("stays disabled while the initiator lock is only at the head (awaiting depth)", () => {
    const m = derive("taker", { eth: iOpen(), qrl: none() }, {});
    expect(m.steps[1].canRun).toBe(false);
    expect(m.steps[1].awaitingDepth).toBe(true);
    expect(m.steps[1].issue).toBeNull();
  });

  it("fails closed when the confirmed snapshot is missing entirely", () => {
    const m = derive("taker", { eth: iOpen(), qrl: none() }, { qrl: none() });
    expect(m.steps[1].canRun).toBe(false);
    expect(m.steps[1].awaitingDepth).toBe(true);
  });

  it("enables once the agreed lock is visible at depth", () => {
    const m = derive("taker", { eth: iOpen(), qrl: none() }, { eth: iOpen(), qrl: none() });
    expect(m.steps[1].canRun).toBe(true);
    expect(m.steps[1].awaitingDepth).toBe(false);
    expect(m.steps[1].issue).toBeNull();
  });

  it("rejects a confirmed lock paying someone else", () => {
    const bad = iOpen({ recipient: MAKER_ETH });
    const m = derive("taker", { eth: bad, qrl: none() }, { eth: bad, qrl: none() });
    expect(m.steps[1].canRun).toBe(false);
    expect(m.steps[1].issue).toBe("its recipient is not your address");
  });

  it("rejects a confirmed lock escrowing the wrong amount", () => {
    const bad = iOpen({ amount: 2n * ETH_AMOUNT });
    const m = derive("taker", { eth: bad, qrl: none() }, { eth: bad, qrl: none() });
    expect(m.steps[1].canRun).toBe(false);
    expect(m.steps[1].issue).toBe("it escrows 2.0 ETH, not the agreed 1.0");
  });

  it("rejects a confirmed lock whose timeout squeezes the claim window", () => {
    const bad = iOpen({ timeout: R_TIMEOUT + CLAIM_MARGIN_S - 1 });
    const m = derive("taker", { eth: bad, qrl: none() }, { eth: bad, qrl: none() });
    expect(m.steps[1].canRun).toBe(false);
    expect(m.steps[1].issue).toBe("its timeout leaves you too little claim window");
  });

  it("only surfaces the verification issue to the party who acts on it", () => {
    const bad = iOpen({ recipient: MAKER_ETH });
    const m = derive("maker", { eth: bad, qrl: none() }, { eth: bad, qrl: none() });
    expect(m.steps[1].issue).toBeNull();
  });

  it("disables at the responder timeout even with a valid confirmed lock", () => {
    const m = derive(
      "taker",
      { eth: iOpen(), qrl: none() },
      { eth: iOpen(), qrl: none() },
      { nowS: R_TIMEOUT },
    );
    expect(m.steps[1].canRun).toBe(false);
  });
});

describe("step 3: secret reveal (maker's irreversible commit)", () => {
  const bothLocked = { eth: iOpen(), qrl: rOpen() };

  it("stays disabled while the responder lock is only at the head", () => {
    const m = derive("maker", bothLocked, { eth: iOpen(), qrl: none() });
    expect(m.steps[2].canRun).toBe(false);
    expect(m.steps[2].awaitingDepth).toBe(true);
  });

  it("enables for the preimage holder once the responder lock is at depth", () => {
    const m = derive("maker", bothLocked, bothLocked);
    expect(m.steps[2].canRun).toBe(true);
    expect(m.steps[2].awaitingDepth).toBe(false);
  });

  it("never enables for the taker, who has no preimage", () => {
    const m = derive("taker", bothLocked, bothLocked);
    expect(m.steps[2].canRun).toBe(false);
  });

  it("rejects a confirmed responder lock paying someone else", () => {
    const bad = rOpen({ recipient: `0x${TAKER_QRL.slice(1)}` });
    const m = derive("maker", { eth: iOpen(), qrl: bad }, { eth: iOpen(), qrl: bad });
    expect(m.steps[2].canRun).toBe(false);
    expect(m.steps[2].issue).toBe("its recipient is not your address");
  });

  it("rejects a confirmed responder lock with the wrong amount", () => {
    const bad = rOpen({ amount: QRL_AMOUNT - 1n });
    const m = derive("maker", { eth: iOpen(), qrl: bad }, { eth: iOpen(), qrl: bad });
    expect(m.steps[2].canRun).toBe(false);
    expect(m.steps[2].issue).toContain("it escrows");
  });

  it("disables at the responder timeout", () => {
    const m = derive("maker", bothLocked, bothLocked, { nowS: R_TIMEOUT });
    expect(m.steps[2].canRun).toBe(false);
  });

  it("matches Q-prefixed plan addresses against hex chain state, case-insensitively", () => {
    const shouted = rOpen({ recipient: `0x${MAKER_QRL.slice(1).toUpperCase()}` });
    const m = derive("maker", { eth: iOpen(), qrl: shouted }, { eth: iOpen(), qrl: shouted });
    expect(m.steps[2].issue).toBeNull();
    expect(m.steps[2].canRun).toBe(true);
  });
});

describe("step 4: claim with the revealed secret", () => {
  it("enables for the taker once the preimage is public and the initiator leg is open", () => {
    const legs = { eth: iOpen(), qrl: claimed(rOpen()) };
    const m = derive("taker", legs, legs);
    expect(m.revealedPreimage).toBe(PREIMAGE);
    expect(m.steps[3].canRun).toBe(true);
  });

  it("treats an all-zero preimage as not revealed", () => {
    const legs = { eth: iOpen(), qrl: rOpen() };
    const m = derive("taker", legs, legs);
    expect(m.revealedPreimage).toBeNull();
    expect(m.steps[3].canRun).toBe(false);
  });

  it("disables at the initiator timeout", () => {
    const legs = { eth: iOpen(), qrl: claimed(rOpen()) };
    const m = derive("taker", legs, legs, { nowS: I_TIMEOUT });
    expect(m.steps[3].canRun).toBe(false);
  });
});

describe("refunds", () => {
  it("offers each role only the leg it initiated, only when open and expired", () => {
    const legs = { eth: iOpen(), qrl: rOpen() };
    const past = { nowS: I_TIMEOUT + 1 };
    expect(derive("maker", legs, legs, past).refundableLegs).toEqual(["eth"]);
    expect(derive("taker", legs, legs, past).refundableLegs).toEqual(["qrl"]);
    expect(derive("sandbox", legs, legs, past).refundableLegs).toEqual(["eth", "qrl"]);
  });

  it("offers nothing before the timeout or on non-open legs", () => {
    const legs = { eth: iOpen(), qrl: rOpen() };
    expect(derive("sandbox", legs, legs).refundableLegs).toEqual([]);
    const done = { eth: claimed(iOpen()), qrl: claimed(rOpen()) };
    expect(derive("sandbox", done, done, { nowS: I_TIMEOUT + 1 }).refundableLegs).toEqual([]);
  });

  it("respects the timeout asymmetry: responder leg refundable first", () => {
    const legs = { eth: iOpen(), qrl: rOpen() };
    const between = { nowS: R_TIMEOUT + 1 };
    expect(derive("maker", legs, legs, between).refundableLegs).toEqual([]);
    expect(derive("taker", legs, legs, between).refundableLegs).toEqual(["qrl"]);
  });
});

describe("completion and identity", () => {
  it("is complete only when both legs are claimed", () => {
    const done = { eth: claimed(iOpen()), qrl: claimed(rOpen()) };
    expect(derive("maker", done, done).complete).toBe(true);
    expect(derive("maker", { eth: iOpen(), qrl: claimed(rOpen()) }, {}).complete).toBe(false);
  });

  it("reports the agreed addresses for the local role", () => {
    const m = derive("taker", {}, {});
    expect(m.ownEth).toBe(TAKER_ETH);
    expect(m.ownQrl).toBe(TAKER_QRL);
    const maker = derive("maker", {}, {});
    expect(maker.ownEth).toBe(MAKER_ETH);
    expect(maker.ownQrl).toBe(MAKER_QRL);
  });

  it("sameAddr bridges Q-prefix and hex casing", () => {
    expect(sameAddr(MAKER_QRL, `0x${MAKER_QRL.slice(1).toUpperCase()}`)).toBe(true);
    expect(sameAddr(MAKER_QRL, `0x${TAKER_QRL.slice(1)}`)).toBe(false);
  });
});
