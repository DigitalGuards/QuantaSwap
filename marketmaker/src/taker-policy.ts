// Pure decision core for the scripted taker: given the book's view of one
// take, the chain state of both legs and what we already sent, decide the
// single next action. No IO here, so every gate is unit-testable; taker.ts
// executes the decisions. This is the taker mirror of policy.ts and of the
// browser's swapMachine.ts.

import { formatUnits } from "ethers";
import { assetInfo, type AssetSymbol } from "./assets.js";
import {
  NATIVE_TOKEN,
  QRL_NATIVE_TOKEN,
  SwapStatus,
  sameAddr,
  type LegKey,
  type LegState,
} from "./htlc.js";
import type { Direction } from "./policy.js";

export const ZERO_BYTES32 = `0x${"0".repeat(64)}`;

export type TakerBookStatus =
  | "open"
  | "accepted"
  | "locking"
  | "cancelled"
  | "gone";

export type TakerDecision =
  /** Nothing to do on this pass. */
  | "wait"
  /** Sign and submit a FillIntentV2 (first attempt or a replacement). */
  | "propose"
  /** Escrow our responder leg: the maker's lock verified at depth. */
  | "lock"
  /** The preimage is public: claim the maker's lock and get paid. */
  | "claim"
  /** Our escrow is open past its own on-chain timeout: reclaim it. */
  | "refund"
  /** Walk away on the book before any funds moved. */
  | "release"
  /** Both legs settled. */
  | "finish"
  /** Nothing of ours is exposed and this take cannot complete. */
  | "abort";

export const initiatorLeg = (direction: Direction): LegKey =>
  direction === "eth->qrl" ? "eth" : "qrl";

export const responderLeg = (direction: Direction): LegKey =>
  direction === "eth->qrl" ? "qrl" : "eth";

/** The exact asset an escrow on `leg` must hold for `asset`: the compiled
 *  in registry address on the Ethereum leg, the native sentinel on QRL.
 *  Never book-provided. */
export function expectedToken(leg: LegKey, asset: AssetSymbol): string {
  if (leg === "qrl") return QRL_NATIVE_TOKEN;
  return assetInfo(asset).tokenAddress ?? NATIVE_TOKEN;
}

/** One leg's agreed terms. */
export interface TakerLegPlan {
  leg: LegKey;
  /** Who the escrow pays when it is claimed. */
  recipient: string;
  /** Base units of this leg's asset. */
  amount: bigint;
  expectedToken: string;
  /** Timeout the escrow must carry, from the signed FillV2. */
  timeout: number;
  asset: AssetSymbol | "QRL";
  decimals: number;
}

export interface TakerPlanInput {
  direction: Direction;
  asset: AssetSymbol;
  /** Maker escrow size, in the initiator leg's base units. */
  fromAmount: bigint;
  /** Our escrow size, in the responder leg's base units. */
  toAmount: bigint;
  makerEthAccount: string;
  makerQrlAccount: string;
  takerEthAccount: string;
  takerQrlAccount: string;
  initiatorTimeout: number;
  responderTimeout: number;
}

export interface TakerPlans {
  /** The maker's escrow, which pays us. */
  initiator: TakerLegPlan;
  /** Our escrow, which pays the maker. */
  responder: TakerLegPlan;
}

function legAsset(
  leg: LegKey,
  asset: AssetSymbol,
): { asset: AssetSymbol | "QRL"; decimals: number } {
  return leg === "qrl"
    ? { asset: "QRL", decimals: 18 }
    : { asset, decimals: assetInfo(asset).decimals };
}

export function takerLegPlans(input: TakerPlanInput): TakerPlans {
  const iLeg = initiatorLeg(input.direction);
  const rLeg = responderLeg(input.direction);
  return {
    initiator: {
      leg: iLeg,
      recipient: iLeg === "eth" ? input.takerEthAccount : input.takerQrlAccount,
      amount: input.fromAmount,
      expectedToken: expectedToken(iLeg, input.asset),
      timeout: input.initiatorTimeout,
      ...legAsset(iLeg, input.asset),
    },
    responder: {
      leg: rLeg,
      recipient: rLeg === "eth" ? input.makerEthAccount : input.makerQrlAccount,
      amount: input.toAmount,
      expectedToken: expectedToken(rLeg, input.asset),
      timeout: input.responderTimeout,
      ...legAsset(rLeg, input.asset),
    },
  };
}

export type MakerLockCheck =
  /** No escrow exists under this hashlock yet. */
  | { state: "absent" }
  /** A pre-funded escrow exists but its recipient is still unset. */
  | { state: "awaiting-assign" }
  /** Verified: recipient, asset, amount and claim window all agree. */
  | { state: "ok" }
  /** Present but wrong. Never fund against it; say exactly why. */
  | { state: "mismatch"; issue: string }
  /** Already claimed or refunded. */
  | { state: "settled" };

/** The zero address at the leg's own width, which is both the native-token
 *  sentinel and the unassigned-recipient marker. */
const legZeroAddress = (leg: LegKey): string =>
  leg === "qrl" ? QRL_NATIVE_TOKEN : NATIVE_TOKEN;

/**
 * Taker-side verification of the maker's escrow before responding with
 * funds. The book announced the parameters; the chain decides. Always
 * evaluated against the confirmation-depth snapshot, because a shallow
 * lock could still be reorged into a different one.
 */
export function checkMakerLock(
  confirmed: LegState | null,
  plan: TakerLegPlan,
  responderTimeout: number,
  claimMarginS: number,
): MakerLockCheck {
  if (confirmed === null) return { state: "absent" };
  if (confirmed.status === SwapStatus.None) return { state: "absent" };
  if (confirmed.status !== SwapStatus.Open) return { state: "settled" };
  if (sameAddr(confirmed.recipient, legZeroAddress(plan.leg))) {
    return { state: "awaiting-assign" };
  }
  // lockNative() and lockToken() share one record, so an escrow with the
  // right recipient and amount but the wrong token pays out a worthless
  // balance on claim. Fail closed on the exact expected asset only.
  if (!sameAddr(confirmed.token, plan.expectedToken)) {
    return { state: "mismatch", issue: "it escrows the wrong asset" };
  }
  if (!sameAddr(confirmed.recipient, plan.recipient)) {
    return { state: "mismatch", issue: "its recipient is not our account" };
  }
  if (confirmed.amount !== plan.amount) {
    return {
      state: "mismatch",
      issue: `it escrows ${confirmed.amount.toString()} base units; the agreed amount is ${plan.amount.toString()}`,
    };
  }
  // Read the claim deadline from the escrow's OWN on-chain timeout, never
  // the announced one: a maker can sign a long window and lock a near-term
  // one, and claim() reverts once the real deadline passes.
  if (confirmed.timeout < responderTimeout + claimMarginS) {
    return {
      state: "mismatch",
      issue: "its timeout leaves too little claim window after ours closes",
    };
  }
  return { state: "ok" };
}

export type OwnLockCheck =
  | { state: "absent" }
  /** Our escrow, matching the plan. */
  | { state: "ours" }
  /** Someone else consumed this hashlock on our leg. */
  | { state: "foreign"; issue: string }
  | { state: "settled" };

/**
 * Classify the escrow on our own leg. The hashlock is public from the
 * moment the maker publishes FillV2, so a third party can squat this leg
 * with a dust swap. Treating a squatted record as ours would have us wait
 * for a claim that pays someone else, or refund an escrow we never funded.
 */
export function checkOwnLock(
  state: LegState | null,
  plan: TakerLegPlan,
  ourAddress: string,
): OwnLockCheck {
  if (state === null || state.status === SwapStatus.None) {
    return { state: "absent" };
  }
  if (!sameAddr(state.initiator, ourAddress)) {
    return {
      state: "foreign",
      issue: "another account already used this hashlock on our leg",
    };
  }
  if (state.status !== SwapStatus.Open) return { state: "settled" };
  if (
    !sameAddr(state.token, plan.expectedToken) ||
    !sameAddr(state.recipient, plan.recipient) ||
    state.amount !== plan.amount
  ) {
    return {
      state: "foreign",
      issue: "our own escrow does not carry the agreed terms",
    };
  }
  return { state: "ours" };
}

/** Persisted send markers the decision reads. */
export interface TakerDecisionRecord {
  /** True only after an exact authenticated locking response was stored. */
  fillAcknowledged: boolean;
  intentSubmittedAt: number | null;
  lockSentAt: number | null;
  claimSentAt: number | null;
  refundSentAt: number | null;
  releaseSentAt: number | null;
}

export interface TakerDecideInput {
  record: TakerDecisionRecord;
  bookStatus: TakerBookStatus;
  /** Our proposal or the selected fill was released on the book. */
  released: boolean;
  /** An authenticated maker CancelV2 ended this order. */
  cancelled: boolean;
  /** Terms from the authenticated FillV2; null while none exists. */
  fill: {
    hashlock: string;
    initiatorTimeout: number;
    responderTimeout: number;
    respondBy: number;
  } | null;
  plans: TakerPlans;
  /** Head state of the maker's leg; null on RPC failure (fail closed). */
  iState: LegState | null;
  /** Maker leg at confirmation depth; null on RPC failure (fail closed). */
  iConfirmed: LegState | null;
  /** Head state of our own leg; null on RPC failure (fail closed). */
  rState: LegState | null;
  /** Our sending account on the responder leg. */
  ourResponderAddress: string;
  /** Unexpired proposal we already submitted, if any. */
  intentPending: { expiresAt: number } | null;
  /** The operator asked to stop before committing funds. */
  abandonRequested: boolean;
  nowS: number;
  resendAfterS: number;
  /** Margin required on a counterparty timeout before we act on it. */
  claimSafetyS: number;
  /** Refuse a new escrow this close to our own responder deadline. */
  lockRunwayS: number;
  /** Stop submitting a claim this close to the escrow's own deadline: a
   *  claim that cannot mine in time only burns the retry slot. */
  claimSubmitMarginS: number;
}

export interface TakerVerdict {
  decision: TakerDecision;
  /** Operator-facing reason; also the funding-refusal explanation. */
  reason: string;
  makerLock: MakerLockCheck;
  ownLock: OwnLockCheck;
  /** Preimage published on-chain by the maker's claim of our leg. */
  revealedPreimage: string | null;
}

const retryOk = (
  sentAt: number | null,
  nowS: number,
  resendAfterS: number,
): boolean => sentAt === null || nowS - sentAt > resendAfterS;

const terminal = (state: LegState | null): boolean =>
  state !== null &&
  (state.status === SwapStatus.Claimed || state.status === SwapStatus.Refunded);

export function decideTaker(x: TakerDecideInput): TakerVerdict {
  const { record, nowS } = x;
  const makerLock = checkMakerLock(
    x.iConfirmed,
    x.plans.initiator,
    x.fill?.responderTimeout ?? 0,
    x.claimSafetyS,
  );
  const ownLock = checkOwnLock(
    x.rState,
    x.plans.responder,
    x.ourResponderAddress,
  );
  const revealedPreimage =
    x.rState !== null && x.rState.preimage !== ZERO_BYTES32
      ? x.rState.preimage
      : null;
  const verdict = (decision: TakerDecision, reason: string): TakerVerdict => ({
    decision,
    reason,
    makerLock,
    ownLock,
    revealedPreimage,
  });

  // Nothing of ours can be on chain while we never sent a lock and our leg
  // carries no escrow of ours.
  const exposed =
    record.lockSentAt !== null ||
    ownLock.state === "ours" ||
    ownLock.state === "settled";

  if (!exposed) {
    if (x.abandonRequested) {
      return x.record.releaseSentAt === null && x.record.intentSubmittedAt !== null
        ? verdict("release", "operator abandoned this take before funding")
        : verdict("abort", "operator abandoned this take before funding");
    }
    if (x.cancelled || x.bookStatus === "cancelled") {
      return verdict("abort", "the maker cancelled this order");
    }
    if (x.bookStatus === "gone") {
      return verdict("abort", "the order is no longer on the book");
    }
    if (x.released) {
      return verdict("abort", "this proposal was released");
    }
  }

  if (x.fill === null) {
    if (exposed) {
      // Only reachable from a corrupted record: an escrow without terms.
      return verdict("wait", "waiting for terms that match our escrow");
    }
    if (x.bookStatus === "locking") {
      return verdict(
        "abort",
        "the maker filled a different proposal on this order",
      );
    }
    if (x.intentPending !== null && x.intentPending.expiresAt > nowS) {
      return verdict("wait", "waiting for the maker to publish FillV2");
    }
    return verdict("propose", "no live proposal for this order");
  }

  const t2 = x.fill.responderTimeout;

  // Our own leg is the one we could double-fund, so an unreadable snapshot
  // decides nothing at all: "no escrow" and "cannot tell" must not share a
  // branch.
  if (x.rState === null) {
    return verdict("wait", "our leg state is unavailable; nothing decided");
  }

  // The secret is public once the maker claims our leg, so claiming the
  // maker's escrow is the payout step. Gate on that escrow's OWN on-chain
  // deadline: claim() reverts once it passes.
  if (
    revealedPreimage !== null &&
    x.iState !== null &&
    x.iState.status === SwapStatus.Open &&
    nowS < x.iState.timeout - x.claimSubmitMarginS &&
    retryOk(record.claimSentAt, nowS, x.resendAfterS)
  ) {
    return verdict("claim", "the preimage is public; claiming our payout");
  }

  if (terminal(x.iState) && terminal(x.rState)) {
    return verdict("finish", "both legs settled");
  }

  // Our leg is settled and the maker escrow can no longer pay us, so
  // nothing of ours is actionable and there is nothing left to watch.
  if (
    terminal(x.rState) &&
    x.iState !== null &&
    x.iState.status === SwapStatus.Open &&
    nowS >= x.iState.timeout
  ) {
    return verdict("finish", "our leg settled and the maker escrow expired");
  }

  // Our own escrow past its on-chain deadline with no claim: reclaim it.
  if (
    ownLock.state === "ours" &&
    x.rState !== null &&
    nowS >= x.rState.timeout &&
    retryOk(record.refundSentAt, nowS, x.resendAfterS)
  ) {
    return verdict("refund", "our escrow passed its timeout unclaimed");
  }

  if (ownLock.state === "foreign") {
    return exposed
      ? verdict("wait", ownLock.issue)
      : verdict("abort", ownLock.issue);
  }

  // Fund our leg only against a maker escrow verified at depth, with a
  // durable authenticated FillV2 behind it and real runway left.
  if (ownLock.state === "absent") {
    if (terminal(x.iState)) {
      return verdict(
        exposed ? "wait" : "abort",
        "the maker escrow settled without us",
      );
    }
    if (!record.fillAcknowledged) {
      return verdict(
        "wait",
        "waiting for a durable authenticated FillV2 before funding",
      );
    }
    if (x.released || x.cancelled) {
      return verdict("wait", "funding stopped: this take was released");
    }
    // Refuse the whole take once too little of our own window is left: a
    // late escrow cannot be claimed by the maker, and it only exposes us.
    if (nowS + x.lockRunwayS >= t2) {
      return verdict(
        exposed ? "wait" : "abort",
        "refusing to fund: our own deadline leaves too little runway",
      );
    }
    if (makerLock.state === "absent") {
      return verdict("wait", "waiting for the maker to escrow their leg");
    }
    if (makerLock.state === "awaiting-assign") {
      return verdict(
        "wait",
        "waiting for the maker to assign their pre-funded escrow",
      );
    }
    if (makerLock.state === "settled") {
      return verdict(
        exposed ? "wait" : "abort",
        "the maker escrow settled without us",
      );
    }
    if (makerLock.state === "mismatch") {
      return verdict(
        exposed ? "wait" : "abort",
        `refusing to fund: the maker escrow is wrong, ${makerLock.issue}`,
      );
    }
    if (!retryOk(record.lockSentAt, nowS, x.resendAfterS)) {
      return verdict("wait", "waiting for our escrow to appear on chain");
    }
    return verdict("lock", "the maker escrow verified at depth");
  }

  if (ownLock.state === "ours") {
    return verdict("wait", "waiting for the maker to claim and reveal");
  }

  if (!exposed && nowS >= t2) {
    return verdict("abort", "the responder window closed without a swap");
  }

  if (x.rState === null || x.iState === null) {
    return verdict("wait", "chain state unavailable; nothing decided");
  }

  return verdict("wait", "nothing to do");
}

/** Bounds a take before any proposal is signed. Pure so the CLI and the
 *  engine apply one rule set. */
export interface TakeBoundsInput {
  /** Base units we would escrow. */
  payAmount: bigint;
  /** Base units we would receive. */
  receiveAmount: bigint;
  /** Display units for the two amounts, so a refusal names real numbers. */
  pay?: { symbol: string; decimals: number };
  receive?: { symbol: string; decimals: number };
  maxIn: bigint | null;
  minOut: bigint | null;
  /** Spendable balance on the leg we pay from. */
  payBalance: bigint | null;
  /** True when the escrow asset is that leg's native coin, so one balance
   *  has to cover both the escrow and its gas. */
  nativePayLeg: boolean;
  /** Native balance on the leg that pays gas for our escrow. */
  gasBalance: bigint | null;
  gasReserve: bigint;
  /** Order proof expiry. */
  orderExpiresAt: number;
  nowS: number;
  /** Runway a take needs before the order proof expires. */
  minOrderRunwayS: number;
}

export function takeBoundsIssue(x: TakeBoundsInput): string | null {
  if (x.payAmount <= 0n || x.receiveAmount <= 0n) {
    return "the order quotes a zero amount";
  }
  const show = (
    amount: bigint,
    unit: { symbol: string; decimals: number } | undefined,
  ): string =>
    unit === undefined
      ? `${amount.toString()} base units`
      : `${formatUnits(amount, unit.decimals)} ${unit.symbol}`;
  if (x.maxIn !== null && x.payAmount > x.maxIn) {
    return `the order asks ${show(x.payAmount, x.pay)}, above the --max-in limit of ${show(x.maxIn, x.pay)}`;
  }
  if (x.minOut !== null && x.receiveAmount < x.minOut) {
    return `the order pays ${show(x.receiveAmount, x.receive)}, below the --min-out floor of ${show(x.minOut, x.receive)}`;
  }
  if (x.orderExpiresAt - x.nowS < x.minOrderRunwayS) {
    return "the order proof expires too soon to swap safely";
  }
  if (x.payBalance !== null && x.payBalance < x.payAmount) {
    return "the funding account holds less than this order asks for";
  }
  if (
    x.nativePayLeg &&
    x.payBalance !== null &&
    x.payBalance < x.payAmount + x.gasReserve
  ) {
    return "the funding account cannot cover this order and its gas reserve";
  }
  if (x.gasBalance !== null && x.gasBalance < x.gasReserve) {
    return "the funding account holds too little native balance for gas";
  }
  return null;
}
