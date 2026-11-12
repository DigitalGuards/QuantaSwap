import { describe, expect, it } from "vitest";
import {
  HOLD_CHECK_S,
  HOLD_SAFETY_S,
  claimHoldWindow,
  claimedByOther,
  payoutStillOpen,
  clock,
  nowLine,
  type NowLineInput,
  type NowLineStep,
} from "./swapNowLine";

const NOW = 1_800_000_000;
type Key = "lock-initiator" | "lock-responder" | "claim-responder" | "claim-initiator";

const step = (
  key: NowLineStep["key"],
  leg: NowLineStep["leg"],
  own: boolean,
  over: Partial<NowLineStep> = {},
): NowLineStep => ({
  key,
  leg,
  own,
  done: false,
  canRun: false,
  issue: null,
  awaitingDepth: false,
  ...over,
});

/** Taker view of an ETH to Quanta swap: initiator leg eth, responder leg qrl. */
const takerSteps = (over: Partial<Record<Key, Partial<NowLineStep>>> = {}) => [
  step("lock-initiator", "eth", false, { done: true, ...over["lock-initiator"] }),
  step("lock-responder", "qrl", true, over["lock-responder"]),
  step("claim-responder", "qrl", false, over["claim-responder"]),
  step("claim-initiator", "eth", true, over["claim-initiator"]),
];
/** Maker view of the same swap. */
const makerSteps = (over: Partial<Record<Key, Partial<NowLineStep>>> = {}) => [
  step("lock-initiator", "eth", true, over["lock-initiator"]),
  step("lock-responder", "qrl", false, over["lock-responder"]),
  step("claim-responder", "qrl", true, over["claim-responder"]),
  step("claim-initiator", "eth", false, over["claim-initiator"]),
];

const base = (over: Partial<NowLineInput> = {}): NowLineInput => ({
  steps: takerSteps(),
  complete: false,
  busy: null,
  busySent: false,
  actionKey: (s) => `${s.key.startsWith("lock") ? "lock" : "claim"}-${s.leg}`,
  stepGated: () => false,
  pendingOwnStepIdx: -1,
  holdingOwnStepIdx: -1,
  holdKind: "auto",
  holdS: 0,
  copy: {
    "lock-initiator": {
      label: "Lock ETH",
      pendingText: null,
      waitingText: "Waiting for the maker to lock…",
    },
    "assign-initiator": {
      label: "Assign taker",
      pendingText: null,
      waitingText: "Waiting for the maker to assign…",
    },
    "lock-responder": {
      label: "Lock Quanta",
      pendingText: "Initiator lock detected on Sepolia; confirming it at the chain head.",
      waitingText: "Waiting for the taker to lock their leg…",
    },
    "claim-responder": {
      label: "Claim Quanta",
      pendingText: "Responder lock detected on QRL; confirming it at the chain head.",
      waitingText: "Waiting for the maker to claim and reveal the secret…",
    },
    "claim-initiator": {
      label: "Claim ETH",
      pendingText: null,
      waitingText: "Waiting for the taker to claim…",
    },
  },
  chainName: { eth: "Sepolia", qrl: "QRL" },
  symbol: { eth: "ETH", qrl: "Quanta" },
  refundableLegs: [],
  releasableLegs: [],
  ownLockedLegs: [],
  ownLegsKnown: true,
  legTimeout: { eth: NOW + 7200, qrl: NOW + 3600 },
  takerWalkedAway: false,
  legRefunded: false,
  nowS: NOW,
  responderTimeout: NOW + 3600,
  ...over,
});

const text = (over: Partial<NowLineInput>) => nowLine(base(over)).line?.text;
const REFUND_FROM = (symbol: string, ts: number) =>
  `Your ${symbol} can be refunded here from ${new Date(ts * 1000).toLocaleString()}.`;

describe("nowLine", () => {
  it("is empty when the swap is complete", () => {
    expect(nowLine(base({ complete: true })).line).toBeNull();
  });

  it("names the step and its number when an own step can run", () => {
    const steps = takerSteps({
      "lock-responder": { done: true },
      "claim-responder": { done: true },
      "claim-initiator": { canRun: true },
    });
    const result = nowLine(base({ steps }));
    expect(result.line).toEqual({ text: "Your turn: Claim ETH in step 4 below.", tone: "turn" });
    expect(result.highlightIdx).toBe(2 + 1);
  });

  it("gives no Your turn while a gate (signed fill check) blocks the runnable step", () => {
    const steps = takerSteps({ "lock-responder": { canRun: true } });
    const result = nowLine(base({ steps, stepGated: (s) => s.key === "lock-responder" }));
    expect(result.line).toBeNull();
  });

  it("gives no line for an unbound legacy swap whose only runnable step is gated", () => {
    const steps = takerSteps({ "lock-responder": { canRun: true } });
    expect(nowLine(base({ steps, stepGated: () => true })).line).toBeNull();
  });

  it("shows a generic in-progress line when a refund is the busy action", () => {
    const line = text({ busy: "refund-qrl", refundableLegs: ["qrl"] });
    expect(line).toBe(
      "Transaction in progress. Approve it in your wallet if asked, then keep this page open while it confirms. If nothing opened, open your wallet to approve it.",
    );
  });

  it("names the chain when the busy action is a step", () => {
    expect(text({ busy: "lock-qrl" })).toBe(
      "Transaction in progress. Approve it in your wallet if asked, then keep this page open while it confirms on QRL. If nothing opened, open your wallet to approve it.",
    );
  });

  it("says the transaction was sent once the busy step has a reported hash", () => {
    expect(text({ busy: "lock-qrl", busySent: true })).toBe(
      "Transaction sent. Waiting for it to confirm on QRL.",
    );
    expect(text({ busy: "unknown-key", busySent: true })).toBe(
      "Transaction sent. Waiting for it to confirm.",
    );
  });

  it("offers the refund for one or two refundable legs", () => {
    expect(nowLine(base({ refundableLegs: ["qrl"] })).line).toEqual({
      text: "Your turn: refund your Quanta leg below.",
      tone: "turn",
    });
    expect(text({ refundableLegs: ["eth", "qrl"] })).toBe(
      "Your turn: refund your ETH and Quanta legs below.",
    );
    expect(nowLine(base({ refundableLegs: ["qrl"] })).highlightIdx).toBe(-1);
  });

  it("tells a prelocked maker to release and a classic maker to discard", () => {
    expect(text({ steps: makerSteps(), takerWalkedAway: true, releasableLegs: ["eth"] })).toBe(
      "The taker left before you assigned them. Release your escrow below.",
    );
    expect(text({ steps: makerSteps(), takerWalkedAway: true })).toBe(
      "The taker left before you locked. You can discard this swap below.",
    );
  });

  it("waits for the chain read when the taker left and the own leg state is unread", () => {
    expect(
      nowLine(base({ steps: makerSteps(), takerWalkedAway: true, ownLegsKnown: false })).line,
    ).toEqual({
      text: "The taker left. Waiting to read the chain state of your leg.",
      tone: "wait",
    });
  });

  it("says when to refund after a leg was refunded and ours is still locked", () => {
    const line = text({
      steps: makerSteps({ "lock-initiator": { done: true } }),
      legRefunded: true,
      ownLockedLegs: ["eth"],
    });
    expect(line).toBe(
      `A leg of this swap was refunded, so the swap will not complete. ${REFUND_FROM("ETH", NOW + 7200)}`,
    );
  });

  it("hints at discarding after a refund only when nothing of ours is locked and known", () => {
    expect(text({ legRefunded: true })).toBe(
      "A leg of this swap was refunded, so the swap will not complete. You can discard this swap below.",
    );
    expect(text({ legRefunded: true, ownLegsKnown: false })).toBe(
      "A leg of this swap was refunded, so the swap will not complete.",
    );
  });

  it("reports a closed window to a taker with known, empty own legs", () => {
    const result = nowLine(base({ nowS: NOW + 3601 }));
    expect(result.line?.text).toBe(
      "The time window for step 2 has closed, so the swap will not complete. You can discard this swap below.",
    );
    expect(result.highlightIdx).toBe(-1);
  });

  it("omits the discard hint when the own leg state is unread", () => {
    expect(text({ nowS: NOW + 3601, ownLegsKnown: false })).toBe(
      "The time window for step 2 has closed, so the swap will not complete.",
    );
  });

  it("tells the maker the other side missed the window and when the refund opens", () => {
    const steps = makerSteps({ "lock-initiator": { done: true } });
    expect(text({ steps, nowS: NOW + 3601, ownLockedLegs: ["eth"] })).toBe(
      `The other side did not act in time, so the swap will not complete. ${REFUND_FROM("ETH", NOW + 7200)}`,
    );
  });

  it("flags an own step with an issue and drops the highlight", () => {
    const steps = takerSteps({ "lock-responder": { issue: "its recipient is not your address" } });
    const result = nowLine(base({ steps }));
    expect(result.line?.text).toBe(
      "Step 2 cannot continue safely. See the warning on that step below.",
    );
    expect(result.highlightIdx).toBe(-1);
  });

  it("shows nothing when the live own step is runnable but gated", () => {
    const steps = takerSteps({ "lock-responder": { canRun: true } });
    expect(nowLine(base({ steps, stepGated: () => true })).line).toBeNull();
  });

  it("uses the pending text of an own step waiting on depth", () => {
    const steps = takerSteps({ "lock-responder": { awaitingDepth: true } });
    expect(nowLine(base({ steps })).line?.text).toBe(
      "Initiator lock detected on Sepolia; confirming it at the chain head.",
    );
  });

  it("says an own step is waiting on chain state when nothing else explains it", () => {
    expect(text({})).toBe("Step 2 is yours. Waiting to read the chain state it depends on.");
  });

  it("ends a counterparty wait with a single period", () => {
    const steps = takerSteps({ "lock-responder": { done: true } });
    const line = text({ steps });
    expect(line).toBe(
      "Waiting for the maker to claim and reveal the secret. This page updates by itself, and you can reopen this swap link later to check progress.",
    );
    expect(line).not.toMatch(/…|\.\./);
    expect(line).not.toContain("Nothing to do");
  });

  it("uses the depth wording while the counterparty step awaits depth", () => {
    const steps = takerSteps({
      "lock-responder": { done: true },
      "claim-responder": { awaitingDepth: true },
    });
    const line = text({ steps });
    expect(line).toBe(
      "Responder lock detected on QRL; confirming it at the chain head. This page updates by itself, and you can reopen this swap link later to check progress.",
    );
    expect(line).not.toContain("Nothing to do");
  });

  it("highlights the open step while the swap moves forward", () => {
    const steps = takerSteps({ "lock-responder": { done: true } });
    expect(nowLine(base({ steps })).highlightIdx).toBe(2);
  });

  it("reports the step whose text the line carries", () => {
    const waiting = nowLine(
      base({
        steps: takerSteps({ "lock-responder": { done: true } }),
      }),
    );
    expect(waiting.carriedIdx).toBe(2);
    const pending = nowLine(
      base({
        steps: takerSteps({
          "lock-responder": { done: true },
          "claim-responder": { awaitingDepth: true },
        }),
      }),
    );
    expect(pending.carriedIdx).toBe(2);
    const own = nowLine(base({ steps: takerSteps({ "lock-responder": { awaitingDepth: true } }) }));
    // The amber depth notice under the user's own step stays.
    expect(own.carriedIdx).toBe(-1);
  });

  it("replaces 'Your turn' with a sent notice while the own transaction is awaited", () => {
    const result = nowLine(
      base({
        steps: takerSteps({ "lock-responder": { canRun: true } }),
        pendingOwnStepIdx: 1,
      }),
    );
    expect(result.line).toEqual({
      text: "Transaction sent. Waiting for it to confirm on QRL.",
      tone: "wait",
    });
    expect(
      nowLine(base({ steps: takerSteps({ "lock-responder": { canRun: true } }) })).line?.text,
    ).toMatch(/^Your turn:/);
  });

  it("carries no step text when the line says something else", () => {
    expect(nowLine(base({ busy: "lock-qrl" })).carriedIdx).toBe(-1);
    expect(nowLine(base({ complete: true })).carriedIdx).toBe(-1);
  });

  it("tells the taker the maker may claim during the hold window, with its length", () => {
    const held = (holdS: number) =>
      nowLine(
        base({
          steps: takerSteps({
            "lock-responder": { done: true },
            "claim-responder": { done: true },
            "claim-initiator": { canRun: true },
          }),
          holdingOwnStepIdx: 3,
          holdS,
        }),
      ).line;
    expect(held(180)).toEqual({
      text: "Your maker may submit this claim for you. If it has not arrived within about 3 minutes, the Claim button appears and your wallet opens for it.",
      tone: "wait",
    });
    expect(held(90)?.text).toContain("within about 2 minutes,");
    const manual = nowLine(
      base({
        steps: takerSteps({
          "lock-responder": { done: true },
          "claim-responder": { done: true },
          "claim-initiator": { canRun: true },
        }),
        holdingOwnStepIdx: 3,
        holdKind: "button",
        holdS: 180,
      }),
    ).line;
    expect(manual?.text).toBe(
      "Your maker may submit this claim for you. If it has not arrived within about 3 minutes, the Claim button appears.",
    );
    const checking = nowLine(
      base({
        steps: takerSteps({
          "lock-responder": { done: true },
          "claim-responder": { done: true },
          "claim-initiator": { canRun: true },
        }),
        holdingOwnStepIdx: 3,
        holdKind: "checking",
        holdS: 180,
      }),
    ).line;
    expect(checking?.text).toBe("Checking whether your maker's claim is still on its way.");
    expect(held(45)?.text).toContain("within about a minute,");
  });
});

describe("claimHoldWindow", () => {
  const MARGIN = 1800;
  const far = 100_000;
  const win = (over: Partial<Parameters<typeof claimHoldWindow>[0]> = {}) =>
    claimHoldWindow({
      holdS: 180,
      claimMarginS: MARGIN,
      nowS: NOW,
      firstSeenS: NOW,
      live: true,
      age: undefined,
      timeLeftS: far,
      ...over,
    });

  it("runs in page time from the age of the reveal", () => {
    expect(win({ age: { ageS: 60, readAtS: NOW } })).toEqual({
      startS: NOW - 60,
      endS: NOW + 120,
      checking: false,
    });
  });

  it("does not move with the device clock: the same age gives the same window", () => {
    // Page time is all the window uses, so a skewed device clock has no input.
    const reload = { firstSeenS: NOW + 5_000, nowS: NOW + 5_000 };
    expect(win({ ...reload, age: { ageS: 60, readAtS: NOW + 5_000 }, live: false })).toEqual({
      startS: NOW + 4_940,
      endS: NOW + 5_120,
      checking: false,
    });
  });

  it("never ends later than first seen plus the hold", () => {
    // A reading that finished late, or an age that is implausibly small.
    const late = win({ firstSeenS: NOW, age: { ageS: 0, readAtS: NOW + 90 } });
    expect(late?.endS).toBe(NOW + 180);
    const old = win({ firstSeenS: NOW, age: { ageS: 400, readAtS: NOW } });
    expect(old?.endS).toBe(NOW - 220);
  });

  it("holds a live step for the whole hold while the age is unknown", () => {
    expect(win()).toEqual({ startS: NOW, endS: NOW + 180, checking: false });
  });

  it("gives a step found on the first reading a short checking window", () => {
    expect(win({ live: false })).toEqual({
      startS: NOW,
      endS: NOW + HOLD_CHECK_S,
      checking: true,
    });
  });

  it("has no window without a first sighting, a hold length or a known time left", () => {
    expect(win({ firstSeenS: undefined })).toBeNull();
    expect(win({ holdS: 0 })).toBeNull();
    expect(win({ timeLeftS: undefined })).toBeNull();
  });

  it("never ends closer to the claim cutoff than the safety span", () => {
    const edge = 180 + MARGIN + HOLD_SAFETY_S;
    expect(win({ timeLeftS: edge })).not.toBeNull();
    expect(win({ timeLeftS: edge - 1 })).toBeNull();
    // Later in the window the same window stays allowed or refused.
    expect(win({ timeLeftS: edge - 100, nowS: NOW + 100 })).not.toBeNull();
  });
});

describe("payoutStillOpen", () => {
  it("is open while the initiator leg is open or not loaded", () => {
    expect(payoutStillOpen(1)).toBe(true);
    expect(payoutStillOpen(undefined)).toBe(true);
    expect(payoutStillOpen(0)).toBe(false);
    expect(payoutStillOpen(2)).toBe(false);
    expect(payoutStillOpen(3)).toBe(false);
  });
});

describe("claimedByOther and clock", () => {
  it("needs a reported own claim and a known sender that is not the own address", () => {
    expect(claimedByOther(["0x01"], "0xcd", true, false)).toBe(true);
    expect(claimedByOther(["0x01"], "0xcd", true, true)).toBe(false);
    expect(claimedByOther(["0x01"], "0xcd", false, false)).toBe(false);
    expect(claimedByOther([], "0xcd", true, false)).toBe(false);
    expect(claimedByOther(["0x01"], null, true, false)).toBe(false);
  });

  it("counts a claiming transaction whose hash the wallet reported as own", () => {
    expect(claimedByOther(["0x01", "0xCD"], "0xcd", true, false)).toBe(false);
  });

  it("formats elapsed seconds as m:ss", () => {
    expect(clock(0)).toBe("0:00");
    expect(clock(65.9)).toBe("1:05");
    expect(clock(-3)).toBe("0:00");
  });
});
