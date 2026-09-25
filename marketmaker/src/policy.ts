// Pure decision core: given the book's view of one of our orders, the
// chain state of both legs, and what we already sent, decide the single
// next action. No IO here so every gate is unit-testable; index.ts
// executes the decisions.

import type { AssetSymbol } from "./assets.js";
import type { DeploymentIdentity } from "./deployment.js";
import { SwapStatus, sameAddr, type LegState } from "./htlc.js";
import type {
  CanonicalOrderV1Body,
  FillIntentV1Body,
  MakerOrderAuthV1,
  SignedCancelV1,
  SignedFillV1,
} from "./protocol-signing.js";

export type Direction = "eth->qrl" | "qrl->eth";

/** A V2 taker proof signs canonical deployment-bound message bytes.
 * The verifier authenticates the full QIP-55 identity before selection. */
export interface FillIntentAuthV1 {
  version: "2";
  scheme: "qrl-sign-message-v2";
  issuedAt: number;
  expiresAt: number;
  nonce: string;
  signature: string;
  publicKey: string;
  descriptor: string;
}

/** Exact mirror artifact selected by the maker. It is retained with the
 *  locally generated secret before a FillV1 is signed. */
export interface SelectedFillIntentV1 {
  intentDigest: string;
  intent: FillIntentV1Body;
  auth: FillIntentAuthV1;
  receivedAt: number;
}

/** Portable protocol state is optional so deployment-bound unsigned
 *  records from earlier releases remain recoverable through their legacy
 *  endpoints. Every present proof is persisted exactly for safe retries. */
export interface ManagedProtocolV1 {
  version: 2;
  orderDigest: string;
  order: CanonicalOrderV1Body;
  orderAuth: MakerOrderAuthV1;
  /** True only after an exact FillV1 book response has authenticated. */
  fillAcknowledged: boolean;
  /** Sticky authenticated release observation. */
  releaseObserved: boolean;
  selectedIntent?: SelectedFillIntentV1;
  fillProof?: SignedFillV1;
  cancelProof?: SignedCancelV1;
}

/** First-come priority for a proposal: its signed issuance, clamped to
 *  when the maker's book received it. The taker chooses issuedAt, so
 *  backdating must not jump proposals that arrived earlier; a book that
 *  under-reports receivedAt can only fall back to issuance order. */
export function intentPriority(intent: SelectedFillIntentV1): number {
  return Math.max(intent.auth.issuedAt, intent.receivedAt);
}

/** Select the first-come valid proposal while refusing expired,
 *  cross-order, or cryptographically invalid ones. Ties fall back to
 *  signed issuance, then the semantic digest. */
export function earliestValidFillIntent(
  intents: readonly SelectedFillIntentV1[],
  orderDigest: string,
  now: number,
  verify: (intent: SelectedFillIntentV1) => boolean,
): SelectedFillIntentV1 | null {
  const valid = intents.filter(
    (candidate) =>
      candidate.intent.orderDigest === orderDigest &&
      candidate.auth.issuedAt <= now &&
      candidate.auth.expiresAt > now &&
      verify(candidate),
  );
  valid.sort(
    (a, b) =>
      intentPriority(a) - intentPriority(b) ||
      a.auth.issuedAt - b.auth.issuedAt ||
      a.intentDigest.localeCompare(b.intentDigest),
  );
  return valid[0] ?? null;
}

export interface ManagedOrder {
  id: string;
  /** Exact chain and HTLC deployment where this order was created. */
  deployment: DeploymentIdentity;
  /** Order book bearer AUTH token for this listing; NOT an asset. */
  token: string | null;
  /** Present on portable signed listings. Absent on legacy unsigned rows. */
  protocol?: ManagedProtocolV1;
  direction: Direction;
  /** ETH-leg asset symbol; the QRL leg is always native. Old persisted
   *  records default to "ETH" on hydration. */
  asset: AssetSymbol;
  /** Price-ladder level this listing fills (0 = tightest). */
  level: number;
  /** Mid (milli-QRL per whole unit of `asset`) this listing was quoted
   *  at; null = pre-feed record, treated as due for repricing. */
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
  /** Last attempt to claim our own initiator lock on the taker's behalf
   *  after the preimage went public; null on older records. */
  sponsorSentAt: number | null;
  refundSentAt: number | null;
  createdAt: number;
}

export type BookStatus = "open" | "accepted" | "locking" | "cancelled" | "gone";

export type Decision =
  | "wait" // nothing to do this tick
  | "announce" // taker arrived: generate/reuse secret, announce hashlock
  | "lock" // escrow our initiator leg
  | "claim" // taker's lock verified at depth: claim it (reveals secret)
  | "sponsor" // secret public: claim our lock for the taker, paying the gas
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
  /** Exact amount the responder lock must escrow, in the receive asset's
   *  base units (QRL wei, or ERC-20 units for a token leg). */
  expectedAmountWei: bigint;
  /** Token the responder lock must escrow: the compiled-in registry
   *  address of the order's asset when we receive the ETH leg, the
   *  native sentinel (address(0)) otherwise. Never book-provided. */
  expectedToken: string;
  nowS: number;
  resendAfterS: number;
  claimSafetyS: number;
  /** Seconds to wait after announcing before locking (grace for instant
   *  taker walk-aways). */
  lockGraceS: number;
  /** Submit the taker's final claim ourselves once the secret is public. */
  sponsorClaims: boolean;
  /** Our address on the initiator leg; a sponsored claim only ever
   *  targets a lock we funded. */
  ourInitiator: string;
  /** The taker's address on our initiator leg (the payout target we
   *  locked for); null when unknown. */
  takerOnInitiatorLeg: string | null;
  /** Skip sponsoring this close to the lock's timeout. Must cover a full
   *  transaction wait, since claim() reverts at the timeout. */
  sponsorMarginS: number;
}

const retryOk = (
  sentAt: number | null,
  nowS: number,
  resendAfterS: number,
): boolean => sentAt === null || nowS - sentAt > resendAfterS;

const terminal = (s: LegState | null): boolean =>
  s !== null &&
  (s.status === SwapStatus.Claimed || s.status === SwapStatus.Refunded);

const chainExposed = (s: LegState | null): boolean =>
  s !== null && s.status !== SwapStatus.None;

/** A coordination outage may be ignored only once durable or on-chain
 * evidence proves that this lifecycle needs settlement handling. */
export function canContinueWithoutBook(
  managed: ManagedOrder,
  iState: LegState | null,
): boolean {
  return (
    managed.protocol?.fillAcknowledged === true ||
    managed.lockSentAt !== null ||
    chainExposed(iState)
  );
}

export function decide(x: DecideInput): Decision {
  const { managed, nowS } = x;
  const t1 = managed.initiatorTimeout;
  const t2 = managed.responderTimeout;
  const released = x.released || managed.protocol?.releaseObserved === true;

  const exposureExcluded =
    managed.lockSentAt === null &&
    (managed.hashlock === null ||
      (x.iState !== null && x.iState.status === SwapStatus.None));

  // Order vanished (cancelled, expired, book wiped) before any funds moved.
  if (
    (x.bookStatus === "gone" || x.bookStatus === "cancelled") &&
    exposureExcluded
  ) {
    return "abort";
  }

  // The taker walked away (authorized release) and nothing of ours is on
  // chain: cancel the listing instead of locking into the void. The refill
  // loop reposts the rung. Once we locked, chain state governs as usual
  // (refund at t1, or claim if the taker locked and then discarded).
  if (released && exposureExcluded) return "abort";

  if (x.bookStatus === "open") return "wait";
  if (x.bookStatus === "accepted") return "announce";

  // From here: status locking, or the book forgot an order that has funds
  // on chain. The chain governs; the book is no longer needed.
  if (
    managed.preimage === null ||
    managed.hashlock === null ||
    t1 === null ||
    t2 === null
  ) {
    return "wait"; // inconsistent snapshot; next tick reconciles
  }
  if (x.iState === null) return "wait"; // RPC gap: fail closed

  // Claim the taker's lock once it is verified AT DEPTH and there is a
  // comfortable margin before its timeout closes the claim window. A lock
  // with the wrong token, recipient, or amount is simply never claimed:
  // we lose nothing and our own leg refunds at t1.
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
    sameAddr(x.rConfirmed.token, x.expectedToken) &&
    sameAddr(x.rConfirmed.recipient, x.expectedRecipient) &&
    x.rConfirmed.amount === x.expectedAmountWei &&
    nowS < x.rConfirmed.timeout - x.claimSafetyS &&
    nowS < t2 - x.claimSafetyS &&
    retryOk(managed.claimSentAt, nowS, x.resendAfterS)
  ) {
    return "claim";
  }

  // Once our claim of the responder leg is visible at depth, the preimage
  // is public and anyone may claim our initiator lock: claim() pays only
  // the recipient fixed at lock time, so doing it ourselves moves nothing
  // the taker is not already owed. It spares the taker gas on the chain
  // they receive on, which a newcomer from the other chain may not hold.
  // The lock must be exactly the one we funded for this taker: the
  // hashlock is public before we lock, so a third party could have taken
  // it with their own dust swap.
  if (
    x.sponsorClaims &&
    x.iState.status === SwapStatus.Open &&
    sameAddr(x.iState.initiator, x.ourInitiator) &&
    x.takerOnInitiatorLeg !== null &&
    sameAddr(x.iState.recipient, x.takerOnInitiatorLeg) &&
    x.rConfirmed !== null &&
    x.rConfirmed.status === SwapStatus.Claimed &&
    nowS < x.iState.timeout - x.sponsorMarginS &&
    retryOk(managed.sponsorSentAt, nowS, x.resendAfterS)
  ) {
    return "sponsor";
  }

  // Escrow our leg after announcing, unless the responder window is
  // already too tight for the taker to plausibly respond and us to claim,
  // or the taker already released (never re-lock into a walked-away swap).
  // A short grace past the announce lets an instant walk-away release
  // before our funds move; a genuine taker loses only those seconds.
  if (
    x.iState.status === SwapStatus.None &&
    x.bookStatus === "locking" &&
    !released &&
    (managed.protocol === undefined || managed.protocol.fillAcknowledged) &&
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
  if (
    x.iState.status === SwapStatus.None &&
    nowS >= t2 &&
    managed.lockSentAt === null
  ) {
    return "abort";
  }

  return "wait";
}

export interface LevelQuote {
  /** Base units the maker escrows on its from-chain. */
  fromAmount: string;
  /** Base units the maker expects back. */
  toAmount: string;
}

/** One rung of the price ladder. Deeper levels quote wider prices and
 *  bigger sizes, like a real book: level 0 asks mid + step, bids
 *  mid - step; level n scales both by n+1. Prices are QRL per whole
 *  asset unit in integer milli; the 10^(18 - assetDecimals) bridge maps
 *  the asset's base units onto 18-decimal QRL wei exactly, so the math
 *  stays integer for 6-decimal assets (USDC, tUSDT) and reduces to the
 *  original formula for 18-decimal native ETH. */
export function levelQuote(args: {
  direction: Direction;
  level: number;
  /** Rung-0 size in the ETH-leg asset's base units. */
  baseUnits: bigint;
  /** Mid in milli-QRL per whole unit of the asset. */
  midPriceMilli: bigint;
  stepBps: bigint;
  /** Decimals of the ETH-leg asset (18 for native ETH, 6 for USDC). */
  assetDecimals: number;
}): LevelQuote {
  const rung = BigInt(args.level + 1);
  const units = args.baseUnits * rung;
  const offsetBps = args.stepBps * rung;
  const priceMilli =
    args.direction === "eth->qrl"
      ? (args.midPriceMilli * (10_000n + offsetBps)) / 10_000n // ask: above mid
      : (args.midPriceMilli * (10_000n - offsetBps)) / 10_000n; // bid: below mid
  const qrlWei =
    (units * priceMilli * 10n ** BigInt(18 - args.assetDecimals)) / 1000n;
  return args.direction === "eth->qrl"
    ? { fromAmount: units.toString(), toAmount: qrlWei.toString() }
    : { fromAmount: qrlWei.toString(), toAmount: units.toString() };
}

export interface RefillInput {
  direction: Direction;
  myOpenCount: number;
  ordersPerDirection: number;
  ordersPerLevel: number;
  inflightCount: number;
  maxInflight: number;
  /** From-side inventory in the from-asset's base units (native wei, or
   *  ERC-20 units for a token pair). */
  balanceWei: bigint;
  reserveWei: bigint;
  orderWei: bigint;
  /** Native balance of the chain that pays gas for the pair's ETH-leg
   *  actions: equal to balanceWei/reserveWei for native pairs, the ETH
   *  native balance and reserve for token pairs (gas headroom for
   *  approve + lockToken + claim). */
  gasBalanceWei: bigint;
  gasReserveWei: bigint;
}

/** Repost only while under the listing target (rungs times listings per
 *  rung), under the in-flight exposure cap, holding inventory beyond the
 *  reserve, and holding native gas headroom on the ETH leg. */
export function shouldPost(x: RefillInput): boolean {
  return (
    x.myOpenCount < x.ordersPerDirection * x.ordersPerLevel &&
    x.inflightCount < x.maxInflight &&
    x.balanceWei >= x.reserveWei + x.orderWei &&
    x.gasBalanceWei >= x.gasReserveWei
  );
}
