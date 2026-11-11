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
  /** The busy-state key of a step's own action button. */
  actionKey: (step: NowLineStep) => string;
  /** True when the step's action is blocked by a gate other than canRun and busy. */
  stepGated: (step: NowLineStep) => boolean;
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
    return make(
      `Transaction in progress. Approve it in your wallet if asked, then keep this page open while it confirms${where}.`,
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
      return make(view.pendingText, "wait", openIdx);
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
    return make(`Nothing to do right now. ${sentence(view.pendingText)} ${TAIL}`, "wait", openIdx);
  }
  if (windowClosed) {
    return make(join("The other side did not act in time, so the swap will not complete."), "wait");
  }
  return make(`Nothing to do right now. ${sentence(view.waitingText)} ${TAIL}`, "wait", openIdx);
}
