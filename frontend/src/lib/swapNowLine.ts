// The "what happens next" line of the swap screen, as a pure decision over
// plain inputs. SwapFlow gathers the inputs and renders the result.

import type { LegKey } from "@/config";
import type { StepModel } from "@/lib/swapMachine";

export interface NowLineStep {
  key: StepModel["key"];
  leg: LegKey;
  own: boolean;
  done: boolean;
  canRun: boolean;
  issue: string | null;
  awaitingDepth: boolean;
}

export interface StepCopy {
  label: string;
  pendingText: string | null;
  waitingText: string;
}

export interface NowLineInput {
  steps: readonly NowLineStep[];
  complete: boolean;
  busy: string | null;
  /** The busy step already has a transaction hash from the wallet. */
  busySent: boolean;
  /** The busy-state key of a step's own action button. */
  actionKey: (step: NowLineStep) => string;
  /** True when the step's action is blocked by a gate other than canRun and busy. */
  stepGated: (step: NowLineStep) => boolean;
  /** Index of an own step whose reported transaction is still awaited, or -1. */
  pendingOwnStepIdx: number;
  /** Index of an own step held back so the maker can claim for the taker, or -1. */
  holdingOwnStepIdx: number;
  /** What follows the hold: the wallet opens by itself, the Claim button
   *  appears, or the hold only covers a lookup of the reveal. */
  holdKind: "auto" | "button" | "checking";
  /** Seconds that held step waits before the wallet opens for it. */
  holdS: number;
  copy: Record<StepModel["key"], StepCopy>;
  chainName: Record<LegKey, string>;
  symbol: Record<LegKey, string>;
  refundableLegs: readonly LegKey[];
  releasableLegs: readonly LegKey[];
  ownLockedLegs: readonly LegKey[];
  /** Every leg this role funds has a loaded on-chain state. */
  ownLegsKnown: boolean;
  /** On-chain timeout per loaded leg. */
  legTimeout: Partial<Record<LegKey, number>>;
  takerWalkedAway: boolean;
  legRefunded: boolean;
  nowS: number;
  responderTimeout: number | undefined;
}

export interface NowLine {
  text: string;
  tone: "turn" | "wait";
}

export interface NowLineResult {
  line: NowLine | null;
  /** Step index that gets the live ring, or -1. */
  highlightIdx: number;
  /** Step index whose pending or waiting text the line already carries, or -1.
   *  The step list skips that text so it is not shown twice. */
  carriedIdx: number;
}

/** A claim hold never runs closer to the claim cutoff than this. The cutoff
 *  itself is CLAIM_MARGIN_S before the leg timeout (the machine refuses the
 *  claim inside it), so a hold ends at least this long before that cutoff. */
export const HOLD_SAFETY_S = 15 * 60;

/** A taker's claim step that was already actionable when the page opened
 *  waits at most this long for the chain lookups that date the reveal. */
export const HOLD_CHECK_S = 20;

export interface ClaimHoldInput {
  /** Longest hold for this leg, in seconds. */
  holdS: number;
  /** CLAIM_MARGIN_S: the machine closes the claim this long before the timeout. */
  claimMarginS: number;
  /** The page clock, in seconds. */
  nowS: number;
  /** Page clock second this page first saw the step as actionable. */
  firstSeenS: number | undefined;
  /** The step turned actionable while this page watched it, so an automatic
   *  start can follow. False for a step found actionable on the first reading. */
  live: boolean;
  /** Age of the reveal on the chain's clock, with the page second it was read. */
  age: { ageS: number; readAtS: number } | undefined;
  /** Seconds left before the claim leg's timeout, now, measured on that
   *  chain's own clock when it is known. */
  timeLeftS: number | undefined;
}

export interface ClaimHold {
  startS: number;
  endS: number;
  /** The reveal could not be dated yet; the window only covers the lookup. */
  checking: boolean;
}

/**
 * The window in which the taker's own claim waits for the maker's sponsored
 * claim, in page time. The reveal's age comes from the chains, so the window
 * starts at (read second minus age) and no device clock can move it. It
 * never ends later than firstSeen + holdS. While the age is unknown a live
 * step waits holdS from firstSeen, and a step found on the first reading only
 * shows a short checking window of HOLD_CHECK_S. The hold is skipped when it
 * would end less than HOLD_SAFETY_S before the claim cutoff, which lies
 * claimMarginS before the leg timeout. Null means no hold.
 */
export function claimHoldWindow(input: ClaimHoldInput): ClaimHold | null {
  const { holdS, claimMarginS, nowS, firstSeenS, live, age, timeLeftS } = input;
  if (holdS <= 0 || firstSeenS === undefined || timeLeftS === undefined) return null;
  let startS: number;
  let endS: number;
  let checking = false;
  if (age !== undefined) {
    startS = Math.min(age.readAtS - age.ageS, firstSeenS);
    endS = Math.min(startS + holdS, firstSeenS + holdS);
  } else if (live) {
    startS = firstSeenS;
    endS = firstSeenS + holdS;
  } else {
    startS = firstSeenS;
    endS = firstSeenS + HOLD_CHECK_S;
    checking = true;
  }
  if (timeLeftS - (endS - nowS) < claimMarginS + HOLD_SAFETY_S) return null;
  return { startS, endS, checking };
}

/** A taker's payout is open while the initiator leg still holds the funds:
 *  status 1 (Open), or a leg state that is not loaded yet. A claimed or
 *  refunded leg has no payout left to wait for. */
export const payoutStillOpen = (initiatorStatus: number | undefined): boolean =>
  initiatorStatus === undefined || initiatorStatus === 1;

/** True when an own claim was reported in this session and the transaction
 *  that claimed the leg came from a known sender other than the own address. */
export const claimedByOther = (
  ownClaimHashes: readonly string[],
  claimTxHash: string | null,
  claimerKnown: boolean,
  claimerIsOwn: boolean,
): boolean =>
  ownClaimHashes.length > 0 &&
  claimTxHash !== null &&
  claimerKnown &&
  !claimerIsOwn &&
  !ownClaimHashes.some((hash) => hash.toLowerCase() === claimTxHash.toLowerCase());

export const CROSSED_CLAIM_NOTE =
  "A claim sent by someone else (normally your maker) arrived first, so your own claim was not needed. Your wallet may list it as failed. It moves nothing and costs only its network fee.";

export const HOLD_END_NOTE =
  "If the claim has not arrived when the bar is full, the Claim button appears.";

export const QRL_BLOCK_NOTE =
  "A new block arrives on the Quanta side about once a minute, so a wait of a minute or two is normal.";

/** Elapsed time as m:ss. */
export const clock = (seconds: number): string => {
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};

const TAIL =
  "This page updates by itself, and you can reopen this swap link later to check progress.";

/** Drops a trailing ellipsis or period so the text can end with one period. */
const sentence = (text: string): string => `${text.replace(/(…|\.\.\.|\.)+\s*$/, "")}.`;

const windowKeys: ReadonlySet<StepModel["key"]> = new Set([
  "lock-responder",
  "claim-responder",
  "assign-initiator",
]);

export function nowLine(input: NowLineInput): NowLineResult {
  const { steps, copy, ownLockedLegs, releasableLegs, refundableLegs } = input;
  const openIdx = steps.findIndex((step) => !step.done);
  const open = openIdx >= 0 ? steps[openIdx] : undefined;
  const n = openIdx + 1;

  const windowClosed =
    open !== undefined &&
    windowKeys.has(open.key) &&
    input.responderTimeout !== undefined &&
    input.nowS >= input.responderTimeout &&
    !open.canRun;

  const stalled =
    refundableLegs.length > 0 ||
    input.takerWalkedAway ||
    input.legRefunded ||
    windowClosed ||
    (open?.issue ?? null) !== null;
  const highlightIdx = input.complete || stalled ? -1 : openIdx;

  const ownRefund = ownLockedLegs
    .map((leg) => {
      const timeout = input.legTimeout[leg];
      return timeout === undefined
        ? null
        : `Your ${input.symbol[leg]} can be refunded here from ${new Date(timeout * 1000).toLocaleString()}.`;
    })
    .filter((sentenceText): sentenceText is string => sentenceText !== null)
    .join(" ");
  const discardHint =
    input.ownLegsKnown && ownLockedLegs.length === 0 ? " You can discard this swap below." : "";
  const join = (head: string): string =>
    ownLockedLegs.length > 0 && ownRefund !== "" ? `${head} ${ownRefund}` : `${head}${discardHint}`;

  const make = (text: string, tone: NowLine["tone"], carriedIdx = -1): NowLineResult => ({
    line: { text, tone },
    highlightIdx,
    carriedIdx,
  });
  const none: NowLineResult = { line: null, highlightIdx, carriedIdx: -1 };

  if (input.complete) return none;

  if (input.busy !== null) {
    const busyStep = steps.find((step) => input.actionKey(step) === input.busy);
    const where = busyStep ? ` on ${input.chainName[busyStep.leg]}` : "";
    if (input.busySent) {
      return make(`Transaction sent. Waiting for it to confirm${where}.`, "wait");
    }
    return make(
      `Transaction in progress. Approve it in your wallet if asked, then keep this page open while it confirms${where}. If nothing opened, open your wallet to approve it.`,
      "wait",
    );
  }

  if (refundableLegs.length > 0) {
    const names = refundableLegs.map((leg) => input.symbol[leg]);
    return make(
      names.length === 1
        ? `Your turn: refund your ${names[0]} leg below.`
        : `Your turn: refund your ${names.join(" and ")} legs below.`,
      "turn",
    );
  }

  if (input.takerWalkedAway) {
    if (releasableLegs.length > 0) {
      return make("The taker left before you assigned them. Release your escrow below.", "turn");
    }
    return input.ownLegsKnown
      ? make("The taker left before you locked. You can discard this swap below.", "wait")
      : make("The taker left. Waiting to read the chain state of your leg.", "wait");
  }

  if (input.legRefunded) {
    return make(join("A leg of this swap was refunded, so the swap will not complete."), "wait");
  }

  const sentStep = input.pendingOwnStepIdx >= 0 ? steps[input.pendingOwnStepIdx] : undefined;
  if (sentStep !== undefined) {
    return make(
      `Transaction sent. Waiting for it to confirm on ${input.chainName[sentStep.leg]}.`,
      "wait",
    );
  }

  if (input.holdingOwnStepIdx >= 0) {
    if (input.holdKind === "checking") {
      return make("Checking whether your maker's claim is still on its way.", "wait");
    }
    const minutes = Math.max(1, Math.ceil(input.holdS / 60));
    const within = `within about ${minutes === 1 ? "a minute" : `${minutes} minutes`}`;
    return make(
      `Your maker may submit this claim for you. If it has not arrived ${within}, the Claim button appears${input.holdKind === "auto" ? " and your wallet opens for it" : ""}.`,
      "wait",
    );
  }

  const runnableIdx = steps.findIndex(
    (step) => !step.done && step.own && step.canRun && !input.stepGated(step),
  );
  const runnable = runnableIdx >= 0 ? steps[runnableIdx] : undefined;
  if (runnable !== undefined) {
    return make(`Your turn: ${copy[runnable.key].label} in step ${runnableIdx + 1} below.`, "turn");
  }

  if (open === undefined) return none;
  const view = copy[open.key];

  if (open.own) {
    if (open.issue !== null) {
      return make(`Step ${n} cannot continue safely. See the warning on that step below.`, "wait");
    }
    if (open.canRun && input.stepGated(open)) return none;
    if (open.awaitingDepth && view.pendingText !== null) {
      return make(sentence(view.pendingText), "wait");
    }
    if (windowClosed) {
      if (releasableLegs.length > 0) {
        return make(`The time window for step ${n} has closed. Release your escrow below.`, "turn");
      }
      return make(
        join(`The time window for step ${n} has closed, so the swap will not complete.`),
        "wait",
      );
    }
    return make(`Step ${n} is yours. Waiting to read the chain state it depends on.`, "wait");
  }

  if (open.awaitingDepth && view.pendingText !== null) {
    return make(`${sentence(view.pendingText)} ${TAIL}`, "wait", openIdx);
  }
  if (windowClosed) {
    return make(join("The other side did not act in time, so the swap will not complete."), "wait");
  }
  return make(`${sentence(view.waitingText)} ${TAIL}`, "wait", openIdx);
}
