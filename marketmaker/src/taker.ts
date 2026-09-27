// Scripted taker engine. It runs the taker side of a portable V2 swap
// end to end: verify a maker order locally, propose a signed FillIntentV2,
// authenticate the maker's terminal FillV2, verify the maker escrow on
// chain at confirmation depth, escrow our own leg, claim once the preimage
// is public, and refund if the maker never proceeds.
//
// Every irreversible action goes through decideTaker() in taker-policy.ts,
// and every piece of recovery material is persisted before the network
// send that needs it. The order book stays coordination only: the chain
// decides. IO lives here; the gates live in the pure modules.

import { randomBytes } from "node:crypto";
import { formatUnits } from "ethers";
import { assetInfo, type AssetSymbol } from "./assets.js";
import type { LegSender } from "./chains.js";
import type { DeploymentIdentity } from "./deployment.js";
import {
  encodeApprove,
  encodeClaim,
  encodeLock,
  encodeLockToken,
  encodeRefund,
  erc20Allowance,
  erc20BalanceOf,
  getConfirmedSwapState,
  getSwapState,
  sameAddr,
  submitPreflightedClaim,
  SwapStatus,
  type LegKey,
  type LegRpc,
  type LegState,
} from "./htlc.js";
import {
  OrderBookConflictError,
  OrderBookUnavailableError,
  OrderGoneError,
} from "./orderbook.js";
import type { Direction } from "./policy.js";
import {
  computeFillIntentDigest,
  ProtocolSigner,
} from "./protocol-signing.js";
import { claimSubmitMarginS, type TakerReadConfig } from "./taker-config.js";
import type { TakerBookClient } from "./taker-orderbook.js";
import {
  decideTaker,
  initiatorLeg,
  responderLeg,
  takeBoundsIssue,
  resumeUrgency,
  takerLegPlans,
  type TakerDecision,
  type TakerLegPlan,
  type TakerPlans,
  type TakerVerdict,
} from "./taker-policy.js";
import {
  FundingBlockedError,
  verifyMakerCancel,
  verifyMakerFill,
  verifyMakerOrder,
  type BookOrderRow,
  type VerifiedTakerOrder,
} from "./taker-proofs.js";
import {
  historyEntryFor,
  latestIntent,
  MAX_RETAINED_INTENTS,
  newTakerSwapRecord,
  selectedIntent,
  signedIntentOf,
  type TakerOutcome,
  type TakerStateFile,
  type TakerSwapRecord,
} from "./taker-state.js";

export interface TakerSigningDeps {
  signer: ProtocolSigner;
  eth: LegSender;
  qrl: LegSender;
  state: TakerStateFile;
  deployment: DeploymentIdentity;
}

export interface TakerDeps {
  cfg: TakerReadConfig;
  book: TakerBookClient;
  legRpc: Record<LegKey, LegRpc>;
  /** Absent for the read-only commands, which never touch key material. */
  signing?: TakerSigningDeps;
  now?: () => number;
  log?: (...args: unknown[]) => void;
  /** Seam for deterministic tests; 32 bytes of hex by default. */
  secret?: () => string;
  sleep?: (ms: number) => Promise<void>;
  /** Print the actions a real run would take, and send nothing. */
  dryRun?: boolean;
}

export interface TakerRunResult {
  record: TakerSwapRecord;
  outcome: TakerOutcome | null;
  /** The last verdict this run produced; null when it made no pass. */
  verdict: TakerVerdict | null;
}

export interface TakeBounds {
  /** Most we will escrow, in base units of the leg we pay from. */
  maxIn?: bigint;
  /** Least we will accept, in base units of the leg we receive on. */
  minOut?: bigint;
}

export interface LegView {
  leg: LegKey;
  amount: bigint;
  symbol: string;
  decimals: number;
  display: string;
}

export interface OrderQuote {
  id: string;
  /** Digest of the exact signed terms this quote describes. */
  orderDigest: string;
  direction: Direction;
  asset: AssetSymbol;
  /** What the taker escrows. */
  pay: LegView;
  /** What the taker receives. */
  receive: LegView;
  /** Receive per unit paid, as a decimal string. */
  price: string;
  makerEthAccount: string;
  makerQrlAccount: string;
  expiresAt: number;
  makerSeen: boolean | null;
  prelocked: boolean;
  /** Why this order cannot be taken right now, if anything. */
  issue: string | null;
}

export interface TakerHistoryLine {
  orderId: string;
  direction: Direction;
  asset: AssetSymbol;
  paid: string;
  received: string;
  outcome: TakerOutcome;
  hashlock: string | null;
  lockTx: string | null;
  claimTx: string | null;
  refundTx: string | null;
  settledAt: number;
}

export interface TakerStatusLine {
  orderId: string;
  direction: Direction;
  asset: AssetSymbol;
  pay: string;
  receive: string;
  phase: string;
  hashlock: string | null;
  responderTimeout: number | null;
  outcome: TakerOutcome | null;
}

const short = (value: string): string => value.slice(0, 10);

/**
 * What a take is doing, read from the send markers alone so the reported
 * phase cannot disagree with them when a post-send write fails.
 */
export function takePhase(record: TakerSwapRecord): string {
  if (record.outcome !== null) return record.outcome;
  if (record.refundSentAt !== null) return "refunding our escrow";
  if (record.claimSentAt !== null) return "claiming our payout";
  if (record.lockSentAt !== null) return "escrowed, waiting for the reveal";
  if (record.approveSentAt !== null) return "approving the token allowance";
  if (record.fillAcknowledged) return "verifying the maker escrow";
  const pending = latestIntent(record);
  return pending === null || pending.submittedAt === null
    ? "no live proposal"
    : "proposed, waiting for FillV2";
}

/** True when a take has sent anything that can move or hold funds. */
export function hasSendMarker(record: TakerSwapRecord): boolean {
  return (
    record.approveSentAt !== null ||
    record.lockSentAt !== null ||
    record.claimSentAt !== null ||
    record.refundSentAt !== null
  );
}

/** Consecutive failed passes that turn a flaky environment into a stop. */
const MAX_STEP_FAILURES = 10;

/**
 * The wait between passes. Its timer is deliberately NOT unref'd: while a
 * take waits for the counterparty there is nothing else holding the event
 * loop (the state lease heartbeat is unref'd, and idle HTTP sockets close
 * on their own), so an unref'd timer here lets Node exit mid-swap and
 * report success. Exported so a test can assert the timer is ref'd.
 */
export function defaultSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** A record whose payout accounts differ from the loaded keys would have
 *  this process fund a swap that pays someone else. */
function recordBelongsToOtherAccounts(
  record: TakerSwapRecord,
  ethAccount: string,
  qrlAccount: string,
): boolean {
  return (
    record.takerEthAccount !== ethAccount.toLowerCase() ||
    record.takerQrlAccount !== qrlAccount
  );
}

/** True when the escrow asset on this leg is the chain's native coin. */
function isNativeLeg(leg: LegKey, asset: AssetSymbol): boolean {
  return leg === "qrl" || assetInfo(asset).tokenAddress === null;
}

function legSymbol(leg: LegKey, asset: AssetSymbol): string {
  return leg === "qrl" ? "QRL" : asset;
}

function legDecimals(leg: LegKey, asset: AssetSymbol): number {
  return leg === "qrl" ? 18 : assetInfo(asset).decimals;
}

function legView(leg: LegKey, asset: AssetSymbol, amount: bigint): LegView {
  const decimals = legDecimals(leg, asset);
  const symbol = legSymbol(leg, asset);
  return {
    leg,
    amount,
    symbol,
    decimals,
    display: `${formatUnits(amount, decimals)} ${symbol}`,
  };
}

/** Receive-per-pay as a decimal string, computed in integer math so a
 *  display value never rounds a limit check into the wrong side. */
function priceString(pay: LegView, receive: LegView): string {
  if (pay.amount === 0n) return "0";
  const scale = 10n ** 8n;
  const scaled =
    (receive.amount * scale * 10n ** BigInt(pay.decimals)) /
    (pay.amount * 10n ** BigInt(receive.decimals));
  return formatUnits(scaled, 8);
}

export class TakerEngine {
  private readonly nowS: () => number;
  private readonly log: (...args: unknown[]) => void;
  private readonly secret: () => string;
  private readonly sleep: (ms: number) => Promise<void>;
  readonly dryRun: boolean;

  constructor(private readonly deps: TakerDeps) {
    this.nowS = deps.now ?? (() => Math.floor(Date.now() / 1000));
    this.log =
      deps.log ??
      ((...args: unknown[]) => {
        console.log(`[taker ${new Date().toISOString()}]`, ...args);
      });
    this.secret = deps.secret ?? (() => `0x${randomBytes(32).toString("hex")}`);
    this.sleep = deps.sleep ?? defaultSleep;
    this.dryRun = deps.dryRun ?? false;
  }

  private signing(): TakerSigningDeps {
    const signing = this.deps.signing;
    if (signing === undefined) {
      throw new Error(
        "this command needs taker keys: set TAKER_ETH_PRIVATE_KEY_FILE and TAKER_QRL_HEXSEED_FILE",
      );
    }
    return signing;
  }

  private sender(leg: LegKey): LegSender {
    const signing = this.signing();
    return leg === "eth" ? signing.eth : signing.qrl;
  }

  private ourAddress(leg: LegKey): string {
    const signing = this.signing();
    return leg === "eth" ? signing.eth.address : signing.qrl.address;
  }

  /** Open public orders this client would be willing to take. */
  async list(): Promise<{ quotes: OrderQuote[]; skipped: number }> {
    const { rows, skipped } = await this.deps.book.listOpen();
    const now = this.nowS();
    const quotes: OrderQuote[] = [];
    let refused = skipped;
    for (const row of rows) {
      const verified = verifyMakerOrder(row, { now });
      if (verified === null || row.status !== "open") {
        refused += 1;
        continue;
      }
      quotes.push(this.quoteFor(verified, now, {}));
    }
    return { quotes, skipped: refused };
  }

  /** Fetch one order, verify its maker proof and terms, and describe the
   *  swap it offers. Read only: it signs nothing and sends nothing. */
  async quote(orderId: string, bounds: TakeBounds = {}): Promise<OrderQuote> {
    const row = await this.deps.book.getRow(orderId);
    const now = this.nowS();
    const verified = verifyMakerOrder(row, { now });
    if (verified === null) {
      throw new Error(
        "this order carries no valid portable maker proof; refusing to quote it",
      );
    }
    if (row.status !== "open") {
      const quote = this.quoteFor(verified, now, bounds);
      return {
        ...quote,
        issue: `the order status is ${row.status}; a take needs an open order`,
      };
    }
    return this.quoteFor(verified, now, bounds);
  }

  private quoteFor(
    verified: VerifiedTakerOrder,
    now: number,
    bounds: TakeBounds,
  ): OrderQuote {
    const iLeg = initiatorLeg(verified.direction);
    const rLeg = responderLeg(verified.direction);
    const receive = legView(iLeg, verified.asset, verified.fromAmount);
    const pay = legView(rLeg, verified.asset, verified.toAmount);
    return {
      id: verified.id,
      orderDigest: verified.orderDigest,
      direction: verified.direction,
      asset: verified.asset,
      pay,
      receive,
      price: priceString(pay, receive),
      makerEthAccount: verified.signed.order.makerEthAccount,
      makerQrlAccount: verified.signed.order.makerQrlAccount,
      expiresAt: verified.expiresAt,
      makerSeen: verified.makerSeen,
      prelocked: verified.prelocked,
      issue: takeBoundsIssue({
        payAmount: pay.amount,
        receiveAmount: receive.amount,
        pay: { symbol: pay.symbol, decimals: pay.decimals },
        receive: { symbol: receive.symbol, decimals: receive.decimals },
        maxIn: bounds.maxIn ?? null,
        minOut: bounds.minOut ?? null,
        payBalance: null,
        gasBalance: null,
        gasReserve: 0n,
        nativePayLeg: isNativeLeg(pay.leg, verified.asset),
        orderExpiresAt: verified.expiresAt,
        nowS: now,
        minOrderRunwayS: this.deps.cfg.minOrderRunwayS,
      }),
    };
  }

  /** Spendable balance on the leg we would escrow from, and the native
   *  balance that pays that leg's gas. */
  private async fundingBalances(
    plan: TakerLegPlan,
    asset: AssetSymbol,
  ): Promise<{ pay: bigint; gas: bigint }> {
    const sender = this.sender(plan.leg);
    const native = await sender.balance();
    if (plan.leg === "qrl") return { pay: native, gas: native };
    const token = assetInfo(asset).tokenAddress;
    if (token === null) return { pay: native, gas: native };
    return {
      pay: await erc20BalanceOf(this.deps.legRpc.eth, token, sender.address),
      gas: native,
    };
  }

  private gasReserve(leg: LegKey): bigint {
    return leg === "eth"
      ? this.deps.cfg.ethGasReserveWei
      : this.deps.cfg.qrlGasReserveWei;
  }

  /**
   * Open a take: verify the order, check the bounds and the funding
   * balances, and persist a record before anything is signed. Returns the
   * durable record the swap loop drives.
   */
  async begin(
    orderId: string,
    bounds: TakeBounds = {},
    /** Digest the operator consented to; a changed order is refused. */
    expectedOrderDigest?: string,
  ): Promise<TakerSwapRecord> {
    const signing = this.signing();
    const existing = signing.state.get(orderId);
    if (existing !== null && existing.outcome === null) {
      this.log(`resuming the take already recorded for order ${short(orderId)}`);
      return existing;
    }
    if (existing !== null) {
      throw new Error(
        `order ${short(orderId)} already settled as ${existing.outcome}; a portable order never reopens`,
      );
    }
    const row = await this.deps.book.getRow(orderId);
    const now = this.nowS();
    const verified = verifyMakerOrder(row, { now });
    if (verified === null) {
      throw new Error(
        "this order carries no valid portable maker proof; refusing to take it",
      );
    }
    if (row.status !== "open") {
      throw new Error(
        `order ${short(orderId)} has status ${row.status}; a take needs an open order`,
      );
    }
    if (
      expectedOrderDigest !== undefined &&
      expectedOrderDigest !== verified.orderDigest
    ) {
      throw new Error(
        `order ${short(orderId)} changed its signed terms since it was quoted; quote it again before taking it`,
      );
    }
    const plans = this.planFor(verified, {
      initiatorTimeout: 0,
      responderTimeout: 0,
    });
    const balances = await this.fundingBalances(plans.responder, verified.asset);
    const payView = legView(plans.responder.leg, verified.asset, plans.responder.amount);
    const receiveView = legView(plans.initiator.leg, verified.asset, plans.initiator.amount);
    const issue = takeBoundsIssue({
      payAmount: plans.responder.amount,
      receiveAmount: plans.initiator.amount,
      pay: { symbol: payView.symbol, decimals: payView.decimals },
      receive: { symbol: receiveView.symbol, decimals: receiveView.decimals },
      maxIn: bounds.maxIn ?? null,
      minOut: bounds.minOut ?? null,
      payBalance: balances.pay,
      gasBalance: balances.gas,
      gasReserve: this.gasReserve(plans.responder.leg),
      nativePayLeg: isNativeLeg(plans.responder.leg, verified.asset),
      orderExpiresAt: verified.expiresAt,
      nowS: now,
      minOrderRunwayS: this.deps.cfg.minOrderRunwayS,
    });
    if (issue !== null) throw new Error(`refusing to take this order: ${issue}`);
    const record = newTakerSwapRecord({
      verified,
      deployment: signing.deployment,
      takerEthAccount: signing.eth.address.toLowerCase(),
      takerQrlAccount: signing.signer.address,
      nowS: now,
    });
    if (this.dryRun) {
      this.log(
        `dry run: would record a take of order ${short(orderId)} paying ${payView.display} for ${receiveView.display}`,
      );
      return record;
    }
    return signing.state.upsert(record);
  }

  private planFor(
    verified: Pick<
      VerifiedTakerOrder,
      "direction" | "asset" | "fromAmount" | "toAmount" | "signed"
    >,
    timeouts: { initiatorTimeout: number; responderTimeout: number },
  ): TakerPlans {
    const signing = this.signing();
    return takerLegPlans({
      direction: verified.direction,
      asset: verified.asset,
      fromAmount: verified.fromAmount,
      toAmount: verified.toAmount,
      makerEthAccount: verified.signed.order.makerEthAccount,
      makerQrlAccount: verified.signed.order.makerQrlAccount,
      takerEthAccount: signing.eth.address.toLowerCase(),
      takerQrlAccount: signing.signer.address,
      initiatorTimeout: timeouts.initiatorTimeout,
      responderTimeout: timeouts.responderTimeout,
    });
  }

  private plansForRecord(record: TakerSwapRecord): TakerPlans {
    return takerLegPlans({
      direction: record.direction,
      asset: record.asset,
      fromAmount: BigInt(record.order.fromAmount),
      toAmount: BigInt(record.order.toAmount),
      makerEthAccount: record.order.makerEthAccount,
      makerQrlAccount: record.order.makerQrlAccount,
      takerEthAccount: record.takerEthAccount,
      takerQrlAccount: record.takerQrlAccount,
      initiatorTimeout: record.fill?.fill.initiatorTimeout ?? 0,
      responderTimeout: record.fill?.fill.responderTimeout ?? 0,
    });
  }

  private async legStateOrNull(
    leg: LegRpc,
    hashlock: string,
    confirmed: boolean,
  ): Promise<LegState | null> {
    try {
      return confirmed
        ? await getConfirmedSwapState(leg, hashlock, this.deps.cfg.confirmations)
        : await getSwapState(leg, hashlock);
    } catch {
      return null; // fail closed; the decision treats null as unverified
    }
  }

  /**
   * One pass over one take: read the book and both chains, decide, and
   * execute at most one action. Safe to call repeatedly; every step is
   * idempotent against the persisted record and chain state.
   */
  async step(
    input: TakerSwapRecord,
    options: { abandon?: boolean } = {},
  ): Promise<{ record: TakerSwapRecord; verdict: TakerVerdict }> {
    const signing = this.signing();
    if (
      recordBelongsToOtherAccounts(input, signing.eth.address, signing.signer.address)
    ) {
      throw new Error(
        `swap ${short(input.orderId)} belongs to other taker accounts; refusing to act on it with these keys`,
      );
    }
    let record = input;
    let row: BookOrderRow | null = null;
    let bookGone = false;
    try {
      row = await this.deps.book.getRow(record.orderId);
    } catch (error) {
      if (error instanceof OrderGoneError) {
        bookGone = true;
      } else if (error instanceof OrderBookUnavailableError) {
        // A coordination outage may be ignored only once durable or
        // on-chain evidence proves this take needs settlement handling.
        if (!record.fillAcknowledged && record.lockSentAt === null) throw error;
        this.log(
          `order ${short(record.orderId)}: book unavailable, settling from chain state`,
        );
      } else {
        throw error;
      }
    }

    if (row !== null) {
      record = this.observeRelease(record, row);
      record = await this.observeFill(record, row);
    }
    if (record.outcome !== null) {
      // observeFill settled this take (permanently blocked funding), so
      // there is nothing left to decide.
      return {
        record,
        verdict: {
          decision: "abort",
          reason: `this take ended as ${record.outcome}`,
          makerLock: { state: "absent" },
          ownLock: { state: "absent" },
          revealedPreimage: null,
        },
      };
    }

    const plans = this.plansForRecord(record);
    const fill = record.fill;
    const hashlock = fill?.fill.hashlock ?? null;
    const iLeg = plans.initiator.leg;
    const rLeg = plans.responder.leg;
    const [iState, iConfirmed, rState] =
      hashlock === null
        ? [null, null, null]
        : await Promise.all([
            this.legStateOrNull(this.deps.legRpc[iLeg], hashlock, false),
            this.legStateOrNull(this.deps.legRpc[iLeg], hashlock, true),
            this.legStateOrNull(this.deps.legRpc[rLeg], hashlock, false),
          ]);

    const pending = latestIntent(record);
    const cancelled =
      row !== null &&
      row.status === "cancelled" &&
      (row.cancelProof === undefined ||
        verifyMakerCancel(row, record.orderDigest, { now: this.nowS() }));
    const verdict = decideTaker({
      record: {
        fillAcknowledged: record.fillAcknowledged,
        intentSubmittedAt: pending?.submittedAt ?? null,
        lockSentAt: record.lockSentAt,
        claimSentAt: record.claimSentAt,
        refundSentAt: record.refundSentAt,
        releaseSentAt: pending?.releasedAt ?? null,
      },
      bookStatus: bookGone ? "gone" : (row?.status ?? "locking"),
      released: record.releaseObserved || row?.released === true,
      cancelled,
      fill:
        fill === undefined
          ? null
          : {
              hashlock: fill.fill.hashlock,
              initiatorTimeout: fill.fill.initiatorTimeout,
              responderTimeout: fill.fill.responderTimeout,
              respondBy: fill.auth.expiresAt,
            },
      prelocked: record.order.prelock !== undefined,
      plans,
      iState,
      iConfirmed,
      rState,
      ourResponderAddress: this.ourAddress(rLeg),
      intentPending:
        pending === null || pending.submittedAt === null || pending.releasedAt !== null
          ? null
          : { expiresAt: pending.auth.expiresAt },
      abandonRequested: options.abandon === true,
      nowS: this.nowS(),
      resendAfterS: this.deps.cfg.resendAfterS,
      claimSafetyS: this.deps.cfg.claimSafetyS,
      lockRunwayS: this.deps.cfg.lockRunwayS,
      claimSubmitMarginS: claimSubmitMarginS(this.deps.cfg),
    });

    record = await this.execute(record, verdict, plans, {
      iState,
      rState,
      row,
    });
    return { record, verdict };
  }

  /** Persist a release observation as a sticky safety fact. */
  private observeRelease(
    record: TakerSwapRecord,
    row: BookOrderRow,
  ): TakerSwapRecord {
    if (!row.released || record.releaseObserved || this.dryRun) return record;
    const signing = this.signing();
    return signing.state.upsert({
      ...record,
      releaseObserved: true,
      updatedAt: this.nowS(),
    });
  }

  /**
   * Authenticate the maker's terminal FillV2 and persist it, along with the
   * acknowledgment that authorizes funding. Nothing is funded from a
   * FillV2 that has not first survived this and reached disk.
   */
  private async observeFill(
    record: TakerSwapRecord,
    row: BookOrderRow,
  ): Promise<TakerSwapRecord> {
    if (record.fillAcknowledged || row.status !== "locking") return record;
    const selected = row.selectedIntent;
    if (selected === undefined) return record;
    const mine = record.intents.find(
      (intent) => intent.intentDigest === selected.intentDigest,
    );
    if (mine === undefined) {
      // The maker selected another taker's proposal. Nothing of ours is
      // exposed, and this OrderV2 never reopens.
      return record;
    }
    let verified;
    try {
      verified = verifyMakerFill(
        row,
        {
          orderDigest: record.orderDigest,
          intent: signedIntentOf(mine),
          intentDigest: mine.intentDigest,
        },
        { now: this.nowS() },
      );
    } catch (error) {
      if (!(error instanceof FundingBlockedError)) throw error;
      // A permanent refusal, so nothing will ever be funded here. Nothing
      // of ours is on chain at this point: the acknowledgment that
      // authorizes funding is exactly what did not happen. Reveal the
      // walk-away secret first, so the maker learns this take is dead
      // before the secret is discarded with the record.
      if (record.lockSentAt !== null) throw error;
      this.log(`order ${short(record.orderId)}: ${error.message}`);
      const submitted = latestIntent(record);
      if (submitted !== null && submitted.submittedAt !== null) {
        return this.release(record);
      }
      return this.settle(record, "aborted", error.message);
    }
    if (verified === null) return record;
    if (this.dryRun) {
      this.log(
        `dry run: would record the authenticated FillV2 ${short(verified.fillDigest)} for order ${short(record.orderId)}`,
      );
      return {
        ...record,
        selectedIntentDigest: mine.intentDigest,
        fill: verified.signed,
        fillDigest: verified.fillDigest,
        fillAcknowledged: true,
      };
    }
    const signing = this.signing();
    const stored = signing.state.upsert({
      ...record,
      selectedIntentDigest: mine.intentDigest,
      fill: verified.signed,
      fillDigest: verified.fillDigest,
      fillAcknowledged: true,
      updatedAt: this.nowS(),
    });
    this.log(
      `order ${short(record.orderId)}: FillV2 authenticated, hashlock ${short(verified.signed.fill.hashlock)}, ` +
        `our deadline ${new Date(verified.signed.fill.responderTimeout * 1000).toISOString()}`,
    );
    return stored;
  }

  private async execute(
    record: TakerSwapRecord,
    verdict: TakerVerdict,
    plans: TakerPlans,
    chain: {
      iState: LegState | null;
      rState: LegState | null;
      row: BookOrderRow | null;
    },
  ): Promise<TakerSwapRecord> {
    switch (verdict.decision) {
      case "wait":
        return record;
      case "propose":
        return this.propose(record, chain.row);
      case "lock":
        return this.lock(record, plans);
      case "claim":
        return this.claim(record, plans, verdict.revealedPreimage);
      case "refund":
        return this.refund(record, plans);
      case "release":
        return this.release(record);
      case "finish":
        return this.settle(
          record,
          chain.iState?.status === SwapStatus.Claimed
            ? chain.rState?.status === SwapStatus.Refunded
              ? "uneven"
              : "claimed"
            : chain.rState?.status === SwapStatus.Refunded
              ? "refunded"
              : "uneven",
          verdict.reason,
        );
      case "abort":
        return this.settle(record, "aborted", verdict.reason);
      default: {
        const unreachable: never = verdict.decision;
        throw new Error(`unhandled taker decision ${String(unreachable)}`);
      }
    }
  }

  /** Sign and publish a FillIntentV2. The proposal and its walk-away
   *  secret reach disk before the book ever sees them. */
  private async propose(
    record: TakerSwapRecord,
    row: BookOrderRow | null,
  ): Promise<TakerSwapRecord> {
    const signing = this.signing();
    const now = this.nowS();
    if (row === null) {
      this.log(
        `order ${short(record.orderId)}: no book view, so no proposal this pass`,
      );
      return record;
    }
    const verified = verifyMakerOrder(row, { now });
    if (verified === null || row.status !== "open") {
      this.log(
        `order ${short(record.orderId)}: no longer an open verified order, so no proposal this pass`,
      );
      return record;
    }
    if (verified.orderDigest !== record.orderDigest) {
      throw new Error(
        `order ${short(record.orderId)} changed its signed terms; refusing to propose`,
      );
    }
    if (this.dryRun) {
      this.log(
        `dry run: would sign and submit a FillIntentV2 for order ${short(record.orderId)}`,
      );
      return record;
    }
    const releaseSecret = this.secret();
    const signed = signing.signer.signFillIntentV1({
      order: { order: record.order, auth: record.orderAuth },
      orderDigest: record.orderDigest,
      takerEthAccount: record.takerEthAccount,
      releaseSecret,
      issuedAt: now,
    });
    const intentDigest = computeFillIntentDigest(signed.intent, signed.auth);
    const retained = [
      ...record.intents.filter(
        (intent) => intent.intentDigest !== intentDigest,
      ),
      {
        intentDigest,
        intent: signed.intent,
        auth: signed.auth,
        releaseSecret,
        // Marked as submitted before the send. A response this client never
        // saw must not look like "never sent": that would mint a second
        // proposal the book refuses and leave the accepted one unmarked.
        submittedAt: now,
        releasedAt: null,
      },
    ];
    // Keep only what the book itself can hold. A proposal is never dropped
    // while it could still be filled or released: its release secret is the
    // walk-away path. Expired, released and unselected ones go first.
    const mustKeep = new Set(
      retained
        .filter(
          (intent) =>
            intent.intentDigest === intentDigest ||
            intent.intentDigest === record.selectedIntentDigest ||
            (intent.releasedAt === null && intent.auth.expiresAt > now),
        )
        .map((intent) => intent.intentDigest),
    );
    const room = Math.max(0, MAX_RETAINED_INTENTS - mustKeep.size);
    const others = retained.filter(
      (intent) => !mustKeep.has(intent.intentDigest),
    );
    const trimmed = [
      ...(room === 0 ? [] : others.slice(-room)),
      ...retained.filter((intent) => mustKeep.has(intent.intentDigest)),
    ];
    const stored = signing.state.upsert({
      ...record,
      intents: trimmed,
      updatedAt: now,
    });
    try {
      await this.deps.book.submitIntent(record.orderId, signed);
    } catch (error) {
      if (error instanceof OrderBookConflictError) {
        this.log(
          `order ${short(record.orderId)}: the book already holds a pending proposal from this account; waiting`,
        );
        return stored;
      }
      throw error;
    }
    this.log(
      `order ${short(record.orderId)}: proposed FillIntentV2 ${short(intentDigest)}, valid for ${
        signed.auth.expiresAt - signed.auth.issuedAt
      }s`,
    );
    return stored;
  }

  /** Escrow our own leg. The send marker is persisted first, so a crash
   *  between write and broadcast can never look like "never sent". */
  private async lock(
    record: TakerSwapRecord,
    plans: TakerPlans,
  ): Promise<TakerSwapRecord> {
    const signing = this.signing();
    const fill = record.fill;
    if (fill === undefined) return record;
    const plan = plans.responder;
    const hashlock = fill.fill.hashlock;
    if (this.dryRun) {
      this.log(
        `dry run: would escrow ${legView(plan.leg, record.asset, plan.amount).display} on the ${plan.leg} leg ` +
          `for ${plan.recipient} until ${new Date(plan.timeout * 1000).toISOString()}`,
      );
      return record;
    }
    const token = plan.leg === "eth" ? assetInfo(record.asset).tokenAddress : null;
    const now = this.nowS();
    if (token !== null) {
      // ERC-20 leg: exact-amount approve, then lockToken with value 0. The
      // allowance read is just a read, so it happens before the marker; the
      // sends happen after it, so a crash mid-sequence cannot double-spend.
      const allowance = await erc20Allowance(
        this.deps.legRpc.eth,
        token,
        signing.eth.address,
        this.deps.cfg.ethHtlc,
      );
      // Each marker is persisted immediately before the send it belongs to.
      // A failed approval must not look like a lock attempt, or the lock
      // decision would be suppressed for a whole resend interval.
      let stored = record;
      if (allowance !== plan.amount) {
        stored = signing.state.upsert({
          ...record,
          approveSentAt: now,
          updatedAt: now,
        });
        if (allowance !== 0n && assetInfo(record.asset).quirks.approvalRace) {
          // USDT-style tokens revert on a nonzero to nonzero approve.
          await signing.eth.send(encodeApprove(this.deps.cfg.ethHtlc, 0n), 0n, token);
        }
        await signing.eth.send(
          encodeApprove(this.deps.cfg.ethHtlc, plan.amount),
          0n,
          token,
        );
      }
      stored = signing.state.upsert({
        ...stored,
        lockSentAt: now,
        updatedAt: now,
      });
      const hash = await signing.eth.send(
        encodeLockToken(hashlock, plan.recipient, token, plan.amount, plan.timeout),
        0n,
      );
      this.log(
        `order ${short(record.orderId)}: escrowed ${record.asset} on the eth leg, tx ${hash}`,
      );
      return signing.state.upsert({ ...stored, lockTx: hash, updatedAt: this.nowS() });
    }
    const stored = signing.state.upsert({
      ...record,
      lockSentAt: now,
      updatedAt: now,
    });
    const hash = await this.sender(plan.leg).send(
      encodeLock(plan.leg, hashlock, plan.recipient, plan.timeout),
      plan.amount,
    );
    this.log(
      `order ${short(record.orderId)}: escrowed ${legView(plan.leg, record.asset, plan.amount).display} on the ${plan.leg} leg, tx ${hash}`,
    );
    return signing.state.upsert({ ...stored, lockTx: hash, updatedAt: this.nowS() });
  }

  /** Claim the maker escrow with the public preimage. A claim that lost a
   *  race to a sponsoring maker already paid us, so an "already Claimed"
   *  record counts as success. */
  private async claim(
    record: TakerSwapRecord,
    plans: TakerPlans,
    preimage: string | null,
  ): Promise<TakerSwapRecord> {
    const signing = this.signing();
    const fill = record.fill;
    if (fill === undefined || preimage === null) return record;
    const leg = plans.initiator.leg;
    const hashlock = fill.fill.hashlock;
    if (this.dryRun) {
      this.log(
        `dry run: would claim ${legView(leg, record.asset, plans.initiator.amount).display} on the ${leg} leg`,
      );
      return record;
    }
    const now = this.nowS();
    const claimData = encodeClaim(leg, hashlock, preimage);
    // The attempt marker is written inside the submit callback, so a failed
    // preflight (which never broadcasts) does not spend the retry slot on
    // our own payout leg.
    let stored = record;
    try {
      const hash = await submitPreflightedClaim(
        this.deps.legRpc[leg],
        this.ourAddress(leg),
        claimData,
        async () => {
          stored = signing.state.upsert({
            ...record,
            claimSentAt: now,
            updatedAt: now,
          });
          return this.sender(leg).send(claimData, 0n);
        },
      );
      this.log(
        `order ${short(record.orderId)}: claimed ${legView(leg, record.asset, plans.initiator.amount).display} on the ${leg} leg, tx ${hash}`,
      );
      return signing.state.upsert({
        ...stored,
        claimTx: hash,
        updatedAt: this.nowS(),
      });
    } catch (error) {
      const current = await this.legStateOrNull(
        this.deps.legRpc[leg],
        hashlock,
        false,
      );
      // A sponsored claim only counts as our payout when it paid the
      // recipient we agreed on: a Claimed record with any other recipient
      // belongs to someone else's swap on the same hashlock.
      if (
        current?.status === SwapStatus.Claimed &&
        sameAddr(current.recipient, plans.initiator.recipient)
      ) {
        this.log(
          `order ${short(record.orderId)}: escrow already claimed for us, likely a sponsored claim; treating as settled`,
        );
        return stored;
      }
      throw error;
    }
  }

  private async refund(
    record: TakerSwapRecord,
    plans: TakerPlans,
  ): Promise<TakerSwapRecord> {
    const signing = this.signing();
    const fill = record.fill;
    if (fill === undefined) return record;
    const leg = plans.responder.leg;
    if (this.dryRun) {
      this.log(`dry run: would refund our escrow on the ${leg} leg`);
      return record;
    }
    const now = this.nowS();
    const stored = signing.state.upsert({
      ...record,
      refundSentAt: now,
      updatedAt: now,
    });
    const hash = await this.sender(leg).send(
      encodeRefund(leg, fill.fill.hashlock),
      0n,
    );
    this.log(
      `order ${short(record.orderId)}: refunded our ${leg} escrow, tx ${hash}`,
    );
    return signing.state.upsert({
      ...stored,
      refundTx: hash,
      updatedAt: this.nowS(),
    });
  }

  /** Reveal the committed walk-away secret so the maker stops waiting. */
  async release(record: TakerSwapRecord): Promise<TakerSwapRecord> {
    const signing = this.signing();
    const intent = selectedIntent(record) ?? latestIntent(record);
    if (intent === null || intent.submittedAt === null) {
      return this.settle(record, "aborted", "no proposal to release");
    }
    if (this.dryRun) {
      this.log(
        `dry run: would release proposal ${short(intent.intentDigest)} on order ${short(record.orderId)}`,
      );
      return record;
    }
    const reference =
      record.fillDigest === undefined
        ? { intentDigest: intent.intentDigest }
        : { fillDigest: record.fillDigest };
    const now = this.nowS();
    let stored = signing.state.upsert({
      ...record,
      intents: record.intents.map((entry) =>
        entry.intentDigest === intent.intentDigest
          ? { ...entry, releasedAt: now }
          : entry,
      ),
      releaseObserved: true,
      updatedAt: now,
    });
    try {
      await this.deps.book.release(
        record.orderId,
        intent.releaseSecret,
        reference,
      );
      this.log(
        `order ${short(record.orderId)}: released proposal ${short(intent.intentDigest)}`,
      );
    } catch (error) {
      if (!(error instanceof OrderGoneError)) throw error;
    }
    stored = this.settle(stored, "released", "released before funding");
    return stored;
  }

  /**
   * Record a terminal outcome. The record is retired and its outcome is
   * appended to the local history, so `status` can still report the take
   * after the recovery material is gone. An uneven settlement keeps its
   * record too, because it needs an operator.
   */
  private settle(
    record: TakerSwapRecord,
    outcome: TakerOutcome,
    reason: string,
  ): TakerSwapRecord {
    const signing = this.signing();
    this.log(`order ${short(record.orderId)}: ${outcome} (${reason})`);
    if (this.dryRun) return { ...record, outcome };
    const settledAt = this.nowS();
    const settled = { ...record, outcome, updatedAt: settledAt };
    if (outcome === "uneven") signing.state.upsert(settled);
    signing.state.settle(
      record.orderId,
      historyEntryFor(settled, outcome, settledAt),
      outcome === "uneven",
    );
    return settled;
  }

  /**
   * Drive one take to a terminal outcome. A transient failure after funding
   * must never end the process: each pass is isolated, logged, and retried
   * after the poll interval, until a run of consecutive failures shows the
   * environment is broken, and no longer merely flaky.
   */
  async run(
    record: TakerSwapRecord,
    options: {
      maxPasses?: number;
      abandon?: () => boolean;
      maxConsecutiveFailures?: number;
    } = {},
  ): Promise<TakerRunResult> {
    const maxPasses = options.maxPasses ?? Number.POSITIVE_INFINITY;
    const failureBudget = options.maxConsecutiveFailures ?? MAX_STEP_FAILURES;
    let current = record;
    let last: TakerVerdict | null = null;
    let failures = 0;
    for (let pass = 0; pass < maxPasses; pass += 1) {
      const abandon = options.abandon?.() === true;
      let verdict: TakerVerdict;
      try {
        const result = await this.step(current, { abandon });
        current = result.record;
        verdict = result.verdict;
        failures = 0;
      } catch (error) {
        failures += 1;
        this.log(
          `order ${short(current.orderId)} pass failed (${failures}/${failureBudget}):`,
          error instanceof Error ? error.message : error,
        );
        if (failures >= failureBudget) {
          throw new Error(
            `order ${short(current.orderId)} failed ${failures} passes in a row; stopping. ` +
              `The record is intact: fix the endpoints and run resume, ideally under a supervisor`,
          );
        }
        if (maxPasses === 1 || this.dryRun) {
          throw error;
        }
        await this.sleep(this.deps.cfg.pollMs);
        continue;

      }
      last = verdict;
      if (
        verdict.decision === "finish" ||
        verdict.decision === "abort" ||
        verdict.decision === "release"
      ) {
        return { record: current, outcome: current.outcome, verdict };
      }
      if (this.dryRun) {
        return { record: current, outcome: null, verdict };
      }
      // No wait on the last pass: a single-pass caller (resume) returns
      // straight away and does its own pacing.
      if (pass + 1 < maxPasses) await this.sleep(this.deps.cfg.pollMs);
    }
    return { record: current, outcome: current.outcome, verdict: last };
  }

  /**
   * Advance every unsettled take. By default this keeps going until each
   * one settles, so a supervised `resume` is a complete backstop after a
   * crash; `once` makes a single pass over each, for cron-style operation.
   */
  async resume(
    options: { once?: boolean; maxRounds?: number } = {},
  ): Promise<TakerVerdict[]> {
    const signing = this.signing();
    const maxRounds = options.maxRounds ?? Number.POSITIVE_INFINITY;
    const verdicts = new Map<string, TakerVerdict>();
    const failures = new Map<string, number>();
    /** Records this run gave up on, so they stop consuming its rounds. */
    const parked = new Set<string>();
    for (let round = 0; round < maxRounds; round += 1) {
      const pending = this.resumeQueue(
        signing.state
          .all()
          .filter(
            (record) =>
              record.outcome === null && !parked.has(record.orderId),
          ),
      );
      if (pending.length === 0) break;
      let settled = 0;
      const roundStarted = Date.now();
      let deferredForBudget = false;
      for (const [index, record] of pending.entries()) {
        // A slow book or a long transaction wait must not spend another
        // take's claim window: once the round's budget is gone, requeue and
        // let the most urgent record go first again. The first record of a
        // round always runs, so progress cannot stall.
        if (
          index > 0 &&
          Date.now() - roundStarted > this.deps.cfg.txTimeoutMs
        ) {
          deferredForBudget = true;
          break;
        }
        try {
          const { verdict } = await this.run(record, { maxPasses: 1 });
          if (verdict !== null) verdicts.set(record.orderId, verdict);
          failures.set(record.orderId, 0);
          if (
            verdict !== null &&
            (verdict.decision === "finish" ||
              verdict.decision === "abort" ||
              verdict.decision === "release")
          ) {
            settled += 1;
          }
        } catch (error) {
          const count = (failures.get(record.orderId) ?? 0) + 1;
          failures.set(record.orderId, count);
          this.log(
            `order ${short(record.orderId)} deferred (${count}/${MAX_STEP_FAILURES}):`,
            error instanceof Error ? error.message : error,
          );
          if (count >= MAX_STEP_FAILURES) {
            this.log(
              `order ${short(record.orderId)} failed ${count} passes in a row; leaving it for the next resume`,
            );
            parked.add(record.orderId);
          }
        }
      }
      if (options.once === true) break;
      if (this.dryRun) break;
      // Wait unless this round settled or parked everything it looked at.
      if (settled < pending.length && !deferredForBudget) {
        await this.sleep(this.deps.cfg.pollMs);
      }
    }
    return [...verdicts.values()];
  }

  /** Unsettled takes in the order a round should work through them. */
  private resumeQueue(records: TakerSwapRecord[]): TakerSwapRecord[] {
    return records
      .map((record) => ({
        record,
        urgency: resumeUrgency({
          fill:
            record.fill === undefined
              ? null
              : {
                  initiatorTimeout: record.fill.fill.initiatorTimeout,
                  responderTimeout: record.fill.fill.responderTimeout,
                },
          orderExpiresAt: record.orderAuth.expiresAt,
          lockSentAt: record.lockSentAt,
        }),
      }))
      .sort(
        (left, right) =>
          left.urgency - right.urgency ||
          left.record.orderId.localeCompare(right.record.orderId),
      )
      .map((entry) => entry.record);
  }

  /** One persisted take, or null when nothing is recorded for that id. */
  record(orderId: string): TakerSwapRecord | null {
    return this.signing().state.get(orderId);
  }

  /** Takes that already settled, newest first. */
  history(): TakerHistoryLine[] {
    return this.signing()
      .state.history()
      .slice()
      .reverse()
      .map((entry) => ({
        orderId: entry.orderId,
        direction: entry.direction,
        asset: entry.asset,
        paid: legView(
          responderLeg(entry.direction),
          entry.asset,
          BigInt(entry.paid),
        ).display,
        received: legView(
          initiatorLeg(entry.direction),
          entry.asset,
          BigInt(entry.received),
        ).display,
        outcome: entry.outcome,
        hashlock: entry.hashlock,
        lockTx: entry.lockTx,
        claimTx: entry.claimTx,
        refundTx: entry.refundTx,
        settledAt: entry.settledAt,
      }));
  }

  /** Everything this state file could not read, for the operator. */
  warnings(): string[] {
    return [...this.signing().state.warnings];
  }

  /** Takes still in flight. A settled take appears in the history only. */
  status(): TakerStatusLine[] {
    const signing = this.signing();
    return signing.state
      .all()
      .filter((record) => record.outcome === null)
      .map((record) => {
      const plans = this.plansForRecord(record);
      return {
        orderId: record.orderId,
        direction: record.direction,
        asset: record.asset,
        pay: legView(plans.responder.leg, record.asset, plans.responder.amount)
          .display,
        receive: legView(
          plans.initiator.leg,
          record.asset,
          plans.initiator.amount,
        ).display,
        phase: takePhase(record),
        hashlock: record.fill?.fill.hashlock ?? null,
        responderTimeout: record.fill?.fill.responderTimeout ?? null,
        outcome: record.outcome,
      };
    });
  }
}

export type { TakerDecision, TakerVerdict };
