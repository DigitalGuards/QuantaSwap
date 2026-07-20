// The full role x chain-state matrix for the swap state machine. Every
// scenario here is one the UI must get right with real funds locked, so
// assertions pin exact gating behavior, not implementation details.

import { describe, expect, it } from "vitest";
import { CLAIM_MARGIN_S, ETH_ASSETS } from "../config";
import { NATIVE_TOKEN, SwapStatus, type LegState } from "./htlc";
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
    takerToken: role === "taker" ? "taker-token-1" : null,
    direction: "eth->qrl",
    ethAsset: "ETH",
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
  token: NATIVE_TOKEN,
  amount: 0n,
  timeout: 0,
  preimage: ZERO32,
});

/** The maker's initiator-leg (eth) lock exactly as agreed. */
const iOpen = (overrides: Partial<LegState> = {}): LegState => ({
  status: SwapStatus.Open,
  initiator: MAKER_ETH,
  recipient: TAKER_ETH,
  token: NATIVE_TOKEN,
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
  token: NATIVE_TOKEN,
  amount: QRL_AMOUNT,
  timeout: R_TIMEOUT,
  preimage: ZERO32,
  ...overrides,
});

const SCAM_TOKEN = "0x1111111111111111111111111111111111111111";

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

  it("rejects a confirmed lock escrowing a token instead of native coin", () => {
    // A lockToken() record shares the struct: right recipient/amount/timeout
    // but pays out a worthless ERC-20 on claim. Must be rejected before the
    // taker escrows real funds.
    const bad = iOpen({ token: SCAM_TOKEN });
    const m = derive("taker", { eth: bad, qrl: none() }, { eth: bad, qrl: none() });
    expect(m.steps[1].canRun).toBe(false);
    expect(m.steps[1].issue).toBe("it escrows a token, not native ETH");
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

  it("rejects a confirmed responder lock escrowing a token instead of native coin", () => {
    const bad = rOpen({ token: SCAM_TOKEN });
    const m = derive("maker", { eth: iOpen(), qrl: bad }, { eth: iOpen(), qrl: bad });
    expect(m.steps[2].canRun).toBe(false);
    expect(m.steps[2].issue).toBe("it escrows a token, not native Quanta");
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

  it("rejects a confirmed responder lock whose own timeout is too near to reveal safely", () => {
    // A hostile taker locks a valid-looking leg with a near-term on-chain
    // timeout; revealing on it publishes the secret into a claim that
    // expires before it mines. Gate on the lock's own timeout + margin.
    const shortLived = rOpen({ timeout: NOW + CLAIM_MARGIN_S - 1 });
    const m = derive("maker", { eth: iOpen(), qrl: shortLived }, { eth: iOpen(), qrl: shortLived });
    expect(m.steps[2].canRun).toBe(false);
    expect(m.steps[2].issue).toBe("its timeout leaves too little window to reveal the secret safely");
  });

  it("never reveals the secret before the maker's own leg is locked", () => {
    const m = derive("maker", { eth: none(), qrl: rOpen() }, { eth: none(), qrl: rOpen() });
    expect(m.steps[2].canRun).toBe(false);
  });

  it("matches Q-prefixed plan addresses against hex chain state, case-insensitively", () => {
    const shouted = rOpen({ recipient: `0x${MAKER_QRL.slice(1).toUpperCase()}` });
    const m = derive("maker", { eth: iOpen(), qrl: shouted }, { eth: iOpen(), qrl: shouted });
    expect(m.steps[2].issue).toBeNull();
    expect(m.steps[2].canRun).toBe(true);
  });
});

describe("ERC-20 ETH-leg verification (stable pairs)", () => {
  const USDC_ADDRESS = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
  const USDC_AMOUNT = 25n * 10n ** 6n; // 25 USDC in 6-decimal base units

  // QRL/USDC pair, direction eth->qrl: the maker escrows USDC on the
  // initiator (eth) leg, so the TAKER's verification demands the token.
  const usdcSwap: Partial<ActiveSwap> = {
    ethAsset: "USDC",
    fromAmount: USDC_AMOUNT.toString(),
  };

  const iOpenUsdc = (overrides: Partial<LegState> = {}): LegState =>
    iOpen({ token: USDC_ADDRESS, amount: USDC_AMOUNT, ...overrides });

  it("pins the registry facts the verification resolves symbols against", () => {
    expect(ETH_ASSETS.ETH.address).toBeNull();
    expect(ETH_ASSETS.USDC.address).toBe(USDC_ADDRESS);
    expect(ETH_ASSETS.USDC.decimals).toBe(6);
    expect(ETH_ASSETS.tUSDT.address).toBe("0x027847Dc41C7a3198a28B9c7B27B5a0BC5bD23A0");
    expect(ETH_ASSETS.tUSDT.quirks.approvalRace).toBe(true);
    expect(ETH_ASSETS.tUSDT.quirks.noReturnValue).toBe(true);
  });

  it("exposes the expected token on the leg plan (native sentinel only for native assets)", () => {
    const native = derive("taker", { eth: none(), qrl: none() }, {});
    expect(native.legPlan.eth.expectedToken).toBe(NATIVE_TOKEN);
    expect(native.legPlan.qrl.expectedToken).toBe(NATIVE_TOKEN);
    const usdc = derive("taker", { eth: none(), qrl: none() }, {}, { swap: usdcSwap });
    expect(usdc.legPlan.eth.expectedToken).toBe(USDC_ADDRESS);
    expect(usdc.legPlan.eth.symbol).toBe("USDC");
    expect(usdc.legPlan.eth.decimals).toBe(6);
    expect(usdc.legPlan.qrl.expectedToken).toBe(NATIVE_TOKEN);
  });

  it("accepts a confirmed initiator lock escrowing exactly the agreed USDC", () => {
    const good = iOpenUsdc();
    const m = derive(
      "taker",
      { eth: good, qrl: none() },
      { eth: good, qrl: none() },
      { swap: usdcSwap },
    );
    expect(m.steps[1].issue).toBeNull();
    expect(m.steps[1].canRun).toBe(true);
  });

  it("rejects a confirmed lock escrowing native coin when USDC was agreed", () => {
    const bad = iOpenUsdc({ token: NATIVE_TOKEN });
    const m = derive(
      "taker",
      { eth: bad, qrl: none() },
      { eth: bad, qrl: none() },
      { swap: usdcSwap },
    );
    expect(m.steps[1].canRun).toBe(false);
    expect(m.steps[1].issue).toBe("it escrows the wrong token contract, not the agreed USDC");
  });

  it("rejects a confirmed lock escrowing a different token when USDC was agreed", () => {
    const bad = iOpenUsdc({ token: SCAM_TOKEN });
    const m = derive(
      "taker",
      { eth: bad, qrl: none() },
      { eth: bad, qrl: none() },
      { swap: usdcSwap },
    );
    expect(m.steps[1].canRun).toBe(false);
    expect(m.steps[1].issue).toBe("it escrows the wrong token contract, not the agreed USDC");
  });

  it("rejects a USDC lock whose amount is off by one base unit, formatted in 6 decimals", () => {
    const bad = iOpenUsdc({ amount: USDC_AMOUNT - 1n });
    const m = derive(
      "taker",
      { eth: bad, qrl: none() },
      { eth: bad, qrl: none() },
      { swap: usdcSwap },
    );
    expect(m.steps[1].canRun).toBe(false);
    expect(m.steps[1].issue).toBe("it escrows 24.999999 USDC, not the agreed 25.0");
  });

  // QRL/USDC pair, direction qrl->eth: the ETH leg is the responder leg,
  // so it is the MAKER's secret-reveal gate that demands the token.
  const usdcReverse: Partial<ActiveSwap> = {
    direction: "qrl->eth",
    ethAsset: "USDC",
    fromAmount: QRL_AMOUNT.toString(),
    toAmount: USDC_AMOUNT.toString(),
  };

  /** Maker's own qrl-leg lock in the reversed direction. */
  const qrlLockRev = (): LegState => ({
    status: SwapStatus.Open,
    initiator: `0x${MAKER_QRL.slice(1)}`,
    recipient: `0x${TAKER_QRL.slice(1)}`,
    token: NATIVE_TOKEN,
    amount: QRL_AMOUNT,
    timeout: I_TIMEOUT,
    preimage: ZERO32,
  });

  /** Taker's eth-leg USDC lock in the reversed direction. */
  const ethLockRev = (overrides: Partial<LegState> = {}): LegState => ({
    status: SwapStatus.Open,
    initiator: TAKER_ETH,
    recipient: MAKER_ETH,
    token: USDC_ADDRESS,
    amount: USDC_AMOUNT,
    timeout: R_TIMEOUT,
    preimage: ZERO32,
    ...overrides,
  });

  it("maker reveals only against the exact USDC escrow on a qrl->eth pair", () => {
    const legs = { qrl: qrlLockRev(), eth: ethLockRev() };
    const m = derive("maker", legs, legs, { swap: usdcReverse });
    expect(m.steps[2].issue).toBeNull();
    expect(m.steps[2].canRun).toBe(true);
  });

  it("maker never reveals against a native lock when the pair is QRL/USDC (qrl->eth)", () => {
    const legs = { qrl: qrlLockRev(), eth: ethLockRev({ token: NATIVE_TOKEN }) };
    const m = derive("maker", legs, legs, { swap: usdcReverse });
    expect(m.steps[2].canRun).toBe(false);
    expect(m.steps[2].issue).toBe("it escrows the wrong token contract, not the agreed USDC");
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

describe("prelocked swaps: assign step, awaiting-assign, release", () => {
  const ZERO_ADDR = `0x${"0".repeat(40)}`;
  const prelockSwap: Partial<ActiveSwap> = { prelocked: true };
  /** The maker's pre-funded escrow: open, recipient still unset. */
  const iOpenUnassigned = (overrides: Partial<LegState> = {}): LegState =>
    iOpen({ recipient: ZERO_ADDR, ...overrides });

  it("replaces the lock step with assign-initiator only when prelocked", () => {
    const pre = derive("maker", { eth: none(), qrl: none() }, {}, { swap: prelockSwap });
    expect(pre.steps[0].key).toBe("assign-initiator");
    const classic = derive("maker", { eth: none(), qrl: none() }, {});
    expect(classic.steps[0].key).toBe("lock-initiator");
  });

  it("assign runs only on an open unassigned escrow with a clean responder leg", () => {
    const legs = { eth: iOpenUnassigned(), qrl: none() };
    const m = derive("maker", legs, {}, { swap: prelockSwap });
    expect(m.steps[0].canRun).toBe(true);
    expect(m.steps[0].done).toBe(false);
    // Responder chain state unknown: fail closed, assign is irreversible.
    const unknown = derive("maker", { eth: iOpenUnassigned() }, {}, { swap: prelockSwap });
    expect(unknown.steps[0].canRun).toBe(false);
  });

  it("refuses to assign while the hashlock is squatted on the responder chain", () => {
    // A dust lock under the shared hashlock over there would make the
    // taker's future lock revert; assigning would also kill release and
    // strand the escrow until T1. The gate must catch it.
    const legs = { eth: iOpenUnassigned(), qrl: rOpen({ amount: 1n }) };
    const m = derive("maker", legs, {}, { swap: prelockSwap });
    expect(m.steps[0].canRun).toBe(false);
    expect(m.steps[0].issue).toBe(
      "the hashlock is already used on the responder chain; release your escrow and relist",
    );
  });

  it("judges assign done at depth, surfacing awaiting-depth in between", () => {
    const assignedHead = { eth: iOpen(), qrl: none() }; // recipient set at head
    const shallow = derive(
      "maker",
      assignedHead,
      { eth: iOpenUnassigned(), qrl: none() },
      { swap: prelockSwap },
    );
    expect(shallow.steps[0].done).toBe(false);
    expect(shallow.steps[0].awaitingDepth).toBe(true);
    const deep = derive("maker", assignedHead, assignedHead, { swap: prelockSwap });
    expect(deep.steps[0].done).toBe(true);
    expect(deep.steps[0].awaitingDepth).toBe(false);
  });

  it("treats an unassigned-at-depth escrow as awaiting assign, not a taker issue", () => {
    const legs = { eth: iOpenUnassigned(), qrl: none() };
    const m = derive("taker", legs, legs, { swap: prelockSwap });
    expect(m.awaitingAssign).toBe(true);
    expect(m.steps[1].issue).toBeNull();
    expect(m.steps[1].canRun).toBe(false);
  });

  it("keeps assigned-to-someone-else a hard issue for the taker", () => {
    const bad = iOpen({ recipient: MAKER_ETH });
    const m = derive("taker", { eth: bad, qrl: none() }, { eth: bad, qrl: none() }, { swap: prelockSwap });
    expect(m.awaitingAssign).toBe(false);
    expect(m.steps[1].canRun).toBe(false);
    expect(m.steps[1].issue).toBe("its recipient is not your address");
  });

  it("opens the responder lock once the assignment to the taker is at depth", () => {
    const assigned = { eth: iOpen(), qrl: none() };
    const m = derive("taker", assigned, assigned, { swap: prelockSwap });
    expect(m.awaitingAssign).toBe(false);
    expect(m.steps[1].canRun).toBe(true);
    expect(m.steps[1].issue).toBeNull();
  });

  it("never reveals the secret while the maker's own escrow is unassigned", () => {
    // With the preimage public an unassigned escrow could still be
    // release()d, taking both sides; the reveal gate must hold even if a
    // buggy taker locked early.
    const legs = { eth: iOpenUnassigned(), qrl: rOpen() };
    const m = derive("maker", legs, legs, { swap: prelockSwap });
    expect(m.steps[2].canRun).toBe(false);
    const assigned = { eth: iOpen(), qrl: rOpen() };
    const ok = derive("maker", assigned, assigned, { swap: prelockSwap });
    expect(ok.steps[2].canRun).toBe(true);
  });

  it("offers release only on an own open unassigned escrow, timeout-free", () => {
    const legs = { eth: iOpenUnassigned(), qrl: none() };
    const m = derive("maker", legs, legs, { swap: prelockSwap });
    expect(m.releasableLegs).toEqual(["eth"]);
    expect(m.refundableLegs).toEqual([]); // before timeout, refund is closed
    // Assigned: release is gone; refund takes over at the timeout.
    const assigned = { eth: iOpen(), qrl: none() };
    const after = derive("maker", assigned, assigned, { swap: prelockSwap });
    expect(after.releasableLegs).toEqual([]);
    // Never offered on classic swaps or to the taker.
    expect(derive("maker", legs, legs).releasableLegs).toEqual([]);
    expect(derive("taker", legs, legs, { swap: prelockSwap }).releasableLegs).toEqual([]);
  });

  it("leaves every classic derivation untouched when prelocked is absent", () => {
    const legs = { eth: iOpen(), qrl: rOpen() };
    const m = derive("maker", legs, legs);
    expect(m.awaitingAssign).toBe(false);
    expect(m.releasableLegs).toEqual([]);
    expect(m.steps.map((s) => s.key)).toEqual([
      "lock-initiator",
      "lock-responder",
      "claim-responder",
      "claim-initiator",
    ]);
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
