// Pure decision core: given the book's view of one of our orders, the
// chain state of both legs, and what we already sent, decide the single
// next action. No IO here so every gate is unit-testable; index.ts
// executes the decisions.

import { NATIVE_TOKEN, SwapStatus, sameAddr, type LegState } from "./htlc.js";

export type Direction = "eth->qrl" | "qrl->eth";

export interface ManagedOrder {
  id: string;
  token: string;
  direction: Direction;
  /** Price-ladder level this listing fills (0 = tightest). */
  level: number;
  /** Mid (milli-QRL/ETH) this listing was quoted at; null = pre-feed
   *  record, treated as due for repricing. */
  quotedMidMilli: string | null;
  fromAmount: string;
  toAmount: string;
  /** Set (and persisted) before the hashlock is announced; never logged. */
  preimage: string | null;
  hashlock: string | null;
  initiatorTimeout: number | null;
  responderTimeout: number | null;
  /** Wall time we announced the hashlock. Locking waits a short grace past
   *  this so a taker's instant walk-away releases before funds move; null
   *  on pre-grace records, treated as no grace. */
  announcedAt: number | null;
  takerEthAccount: string | null;
  takerQrlAccount: string | null;
  lockSentAt: number | null;
  claimSentAt: number | null;
  refundSentAt: number | null;
  createdAt: number;
}

export type BookStatus = "open" | "accepted" | "locking" | "cancelled" | "gone";

export type Decision =
  | "wait" // nothing to do this tick
  | "announce" // taker arrived: generate/reuse secret, announce hashlock
  | "lock" // escrow our initiator leg
  | "claim" // taker's lock verified at depth: claim it (reveals secret)
  | "refund" // our lock is open past its timeout
  | "finish" // both sides settled; stop tracking
  | "abort"; // order evaporated before any funds moved; forget it

export interface DecideInput {
  bookStatus: BookStatus;
  /** The taker released the take (authorized walk-away on the book). */
  released: boolean;
  managed: ManagedOrder;
  /** Latest state of our (initiator) leg; null on RPC failure. */
  iState: LegState | null;
  /** Latest state of the taker's (responder) leg; null on RPC failure. */
  rState: LegState | null;
  /** Responder leg at confirmation depth; null on RPC failure (fail closed). */
  rConfirmed: LegState | null;
  /** Our receiving address on the responder leg. */
  expectedRecipient: string;
  expectedAmountWei: bigint;
  nowS: number;
  resendAfterS: number;
  claimSafetyS: number;
  /** Seconds to wait after announcing before locking (grace for instant
   *  taker walk-aways). */
  lockGraceS: number;
}

const retryOk = (sentAt: number | null, nowS: number, resendAfterS: number): boolean =>
  sentAt === null || nowS - sentAt > resendAfterS;

const terminal = (s: LegState | null): boolean =>
  s !== null && (s.status === SwapStatus.Claimed || s.status === SwapStatus.Refunded);

export function decide(x: DecideInput): Decision {
  const { managed, nowS } = x;
  const t1 = managed.initiatorTimeout;
  const t2 = managed.responderTimeout;

  const everLocked =
    managed.lockSentAt !== null || (x.iState !== null && x.iState.status !== SwapStatus.None);

  // Order vanished (cancelled, expired, book wiped) before any funds moved.
  if ((x.bookStatus === "gone" || x.bookStatus === "cancelled") && !everLocked) return "abort";

  // The taker walked away (authorized release) and nothing of ours is on
  // chain: cancel the listing instead of locking into the void. The refill
  // loop reposts the rung. Once we locked, chain state governs as usual
  // (refund at t1, or claim if the taker locked and then discarded).
  if (x.released && !everLocked) return "abort";

  if (x.bookStatus === "open") return "wait";
  if (x.bookStatus === "accepted") return "announce";

  // From here: status locking, or the book forgot an order that has funds
  // on chain. The chain governs; the book is no longer needed.
  if (managed.preimage === null || managed.hashlock === null || t1 === null || t2 === null) {
    return "wait"; // inconsistent snapshot; next tick reconciles
  }
  if (x.iState === null) return "wait"; // RPC gap: fail closed

  // Claim the taker's lock once it is verified AT DEPTH and there is a
  // comfortable margin before its timeout closes the claim window. A lock
  // with wrong recipient/amount is simply never claimed: we lose nothing
  // and our own leg refunds at t1.
  //
  // The claim window is gated on the responder lock's OWN on-chain timeout
  // (`rConfirmed.timeout`), never the t2 we announced. The taker sets the
  // timeout when they lock; a hostile taker can lock a valid-looking leg
  // (right recipient, right amount) with a near-term timeout, so trusting
  // the announced t2 would have us reveal the secret into a claim that
  // reverts TimeoutPassed after the preimage is already public, letting the
  // taker refund their leg and claim ours. We also refuse to reveal before
  // our own leg is locked: there is never a reason to publish the secret
  // while nothing of ours is on chain.
  if (
    x.iState.status === SwapStatus.Open &&
    x.rState !== null &&
    x.rState.status === SwapStatus.Open &&
    x.rConfirmed !== null &&
    x.rConfirmed.status === SwapStatus.Open &&
    sameAddr(x.rConfirmed.token, NATIVE_TOKEN) &&
    sameAddr(x.rConfirmed.recipient, x.expectedRecipient) &&
    x.rConfirmed.amount === x.expectedAmountWei &&
    nowS < x.rConfirmed.timeout - x.claimSafetyS &&
    nowS < t2 - x.claimSafetyS &&
    retryOk(managed.claimSentAt, nowS, x.resendAfterS)
  ) {
    return "claim";
  }

  // Escrow our leg after announcing, unless the responder window is
  // already too tight for the taker to plausibly respond and us to claim,
  // or the taker already released (never re-lock into a walked-away swap).
  // A short grace past the announce lets an instant walk-away release
  // before our funds move; a genuine taker loses only those seconds.
  if (
    x.iState.status === SwapStatus.None &&
    x.bookStatus === "locking" &&
    !x.released &&
    nowS - (managed.announcedAt ?? 0) >= x.lockGraceS &&
    nowS < t2 - x.claimSafetyS &&
    retryOk(managed.lockSentAt, nowS, x.resendAfterS)
  ) {
    return "lock";
  }

  // Past our timeout with the lock still open: reclaim it. (If the taker
  // did not claim by t1 the contract's windows make this rightfully ours.)
  if (
    x.iState.status === SwapStatus.Open &&
    nowS >= t1 &&
    retryOk(managed.refundSentAt, nowS, x.resendAfterS)
  ) {
    return "refund";
  }

  // Settled: our leg terminal and the responder leg terminal or never
  // touched past its window.
  const rSettled =
    terminal(x.rState) ||
    (x.rState !== null && x.rState.status === SwapStatus.None && nowS >= t2);
  if (terminal(x.iState) && rSettled) return "finish";

  // Never locked and the responder window has closed: nothing will move.
  if (x.iState.status === SwapStatus.None && nowS >= t2 && managed.lockSentAt === null) {
    return "abort";
  }

  // Our lock was attempted but never landed on chain (a send that threw, or
  // an endpoint that dropped it) and t1 has passed: nothing of ours is
  // escrowed and every window is closed, so stop tracking instead of
  // waiting forever. A lock that somehow lands afterwards still refunds to
  // us permissionlessly at its own timeout, no preimage needed.
  if (x.iState.status === SwapStatus.None && nowS >= t1) {
    return "abort";
  }

  return "wait";
}

export interface LevelQuote {
  /** Wei the maker escrows on its from-chain. */
  fromAmount: string;
  /** Wei the maker expects back. */
  toAmount: string;
}

/** One rung of the price ladder. Deeper levels quote wider prices and
 *  bigger sizes, like a real book: level 0 asks mid + step, bids
 *  mid - step; level n scales both by n+1. Prices are QRL per ETH in
 *  integer milli to keep the wei math exact. */
export function levelQuote(args: {
  direction: Direction;
  level: number;
  baseEthWei: bigint;
  midPriceMilli: bigint;
  stepBps: bigint;
}): LevelQuote {
  const rung = BigInt(args.level + 1);
  const ethWei = args.baseEthWei * rung;
  const offsetBps = args.stepBps * rung;
  const priceMilli =
    args.direction === "eth->qrl"
      ? (args.midPriceMilli * (10_000n + offsetBps)) / 10_000n // ask: above mid
      : (args.midPriceMilli * (10_000n - offsetBps)) / 10_000n; // bid: below mid
  const qrlWei = (ethWei * priceMilli) / 1000n;
  return args.direction === "eth->qrl"
    ? { fromAmount: ethWei.toString(), toAmount: qrlWei.toString() }
    : { fromAmount: qrlWei.toString(), toAmount: ethWei.toString() };
}

export interface RefillInput {
  direction: Direction;
  myOpenCount: number;
  ordersPerDirection: number;
  inflightCount: number;
  maxInflight: number;
  balanceWei: bigint;
  reserveWei: bigint;
  orderWei: bigint;
}

/** Repost only while under the listing target, under the in-flight
 *  exposure cap, and holding inventory beyond the reserve. */
export function shouldPost(x: RefillInput): boolean {
  return (
    x.myOpenCount < x.ordersPerDirection &&
    x.inflightCount < x.maxInflight &&
    x.balanceWei >= x.reserveWei + x.orderWei
  );
}
