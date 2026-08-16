// QuantaSwap market maker. An always-online protocol-mode maker: keeps a
// target number of open orders listed per direction, and when one is
// taken it runs the maker side of the swap end-to-end: announce hashlock,
// lock the initiator leg, verify the taker's lock at confirmation depth,
// claim it (revealing the secret), refund on abandonment, repost.
//
// It is a bot driving the same public protocol as any browser maker: the
// order book stays coordination-only and every irreversible action is
// gated on chain state, exactly like frontend/src/lib/swapMachine.ts.

import { createHash, randomBytes } from "node:crypto";
import type { Server } from "node:http";
import { assetInfo, type AssetSymbol } from "./assets.js";
import { loadConfig, type Config } from "./config.js";
import { EthLeg, QrlLeg } from "./chains.js";
import { assertRuntimeChainIds, makeDeploymentIdentity } from "./deployment.js";
import { cancelOpenListing } from "./drain.js";
import {
  NATIVE_TOKEN,
  encodeApprove,
  encodeClaim,
  encodeLock,
  encodeLockToken,
  encodeRefund,
  erc20Allowance,
  erc20BalanceOf,
  getChainId,
  getConfirmedSwapState,
  getSwapState,
  submitPreflightedClaim,
  type LegKey,
  type LegRpc,
  type LegState,
} from "./htlc.js";
import {
  OrderBookClient,
  OrderBookUnavailableError,
  OrderGoneError,
  type OrderView,
} from "./orderbook.js";
import { COINGECKO_URL, PriceFeed, needsReprice } from "./price.js";
import {
  canContinueWithoutBook,
  decide,
  earliestValidFillIntent,
  levelQuote,
  shouldPost,
  type BookStatus,
  type Direction,
  type ManagedOrder,
} from "./policy.js";
import {
  ORDER_V1_DEPLOYMENT,
  ProtocolSigner,
  computeOrderDigest,
  deriveOrderV1Id,
  verifyFillIntentV1,
} from "./protocol-signing.js";
import { StateFile, StateFilePoisonedError, StateProcessLease } from "./state.js";
import { listenHealthServer, MakerHealth } from "./health.js";

const cfg: Config = loadConfig();
const deployment = makeDeploymentIdentity(cfg);
const book = new OrderBookClient(cfg.orderbookUrl, cfg.netTimeoutMs);
const eth = new EthLeg(cfg);
const qrl = new QrlLeg(cfg);
const protocolSigner = new ProtocolSigner(cfg.qrlHexseed);
const stateLease = StateProcessLease.acquire(cfg.stateFile, {
  deploymentFingerprint: deployment.configFingerprint,
  ethAccount: eth.address.toLowerCase(),
  qrlAccount: protocolSigner.address.toLowerCase(),
});
let state: StateFile;
try {
  state = new StateFile(cfg.stateFile, deployment);
} catch (error) {
  stateLease.close();
  protocolSigner.close();
  throw error;
}
const health = new MakerHealth({
  deploymentFingerprint: deployment.configFingerprint,
  assets: cfg.assets,
  draining: cfg.drain,
  staleAfterMs: cfg.healthStaleS * 1000,
});

const legRpc: Record<LegKey, LegRpc> = {
  eth: { url: cfg.ethRpcUrl, ns: "eth", htlc: cfg.ethHtlc, timeoutMs: cfg.netTimeoutMs },
  qrl: { url: cfg.qrlRpcUrl, ns: "qrl", htlc: cfg.qrlHtlc, timeoutMs: cfg.netTimeoutMs },
};

const initiatorLeg = (d: Direction): LegKey => (d === "eth->qrl" ? "eth" : "qrl");
const responderLeg = (d: Direction): LegKey => (d === "eth->qrl" ? "qrl" : "eth");
const sender = (leg: LegKey) => (leg === "eth" ? eth : qrl);
const myAddress = (leg: LegKey): string => (leg === "eth" ? eth.address : qrl.address);

const nowS = (): number => Math.floor(Date.now() / 1000);
const short = (id: string): string => id.slice(0, 8);
const log = (...args: unknown[]) => console.log(`[mm ${new Date().toISOString()}]`, ...args);
const CANCEL_REASON_OPERATOR = 1;
const FILL_RESPONSE_TARGET_S = 5 * 60;

const feed = new PriceFeed({
  url: COINGECKO_URL,
  refreshS: cfg.priceRefreshS,
  maxAgeS: cfg.priceMaxAgeS,
  staticMilli: cfg.priceFeed === "off" ? cfg.midPriceMilli : null,
  timeoutMs: cfg.netTimeoutMs,
  log,
});

function newSecret(): { preimage: string; hashlock: string } {
  const raw = randomBytes(32);
  const digest = createHash("sha256").update(raw).digest("hex");
  return { preimage: `0x${raw.toString("hex")}`, hashlock: `0x${digest}` };
}

function requireMakerToken(managed: ManagedOrder): string {
  if (managed.token === null) {
    throw new Error(`legacy order ${short(managed.id)} has no maker token`);
  }
  return managed.token;
}

function privateMakerToken(managed: ManagedOrder): string | undefined {
  return managed.protocol?.order.visibility === "private"
    ? (managed.token ?? undefined)
    : undefined;
}

function assertPortableDeployment(): void {
  const signedEthHtlc = ORDER_V1_DEPLOYMENT.ethHtlc.split(":").at(-1)?.toLowerCase();
  if (
    deployment.ethChainId !== ORDER_V1_DEPLOYMENT.ethChainId ||
    deployment.qrlChainId !== ORDER_V1_DEPLOYMENT.qrlChainId ||
    deployment.ethHtlc !== signedEthHtlc ||
    deployment.qrlHtlc !== ORDER_V1_DEPLOYMENT.qrlHtlc
  ) {
    throw new Error(
      "configured deployment does not match the portable protocol signing domain",
    );
  }
}

async function cancelManaged(managed: ManagedOrder): Promise<OrderView> {
  const protocol = managed.protocol;
  if (protocol === undefined) {
    return book.cancel(managed.id, requireMakerToken(managed));
  }
  if (protocol.fillProof !== undefined) {
    throw new Error(`order ${short(managed.id)} already has a signed fill`);
  }
  if (protocol.cancelProof === undefined) {
    protocol.cancelProof = protocolSigner.signCancelV1(
      { orderDigest: protocol.orderDigest, reasonCode: CANCEL_REASON_OPERATOR },
      {
        orderNonce: protocol.orderAuth.nonce,
        expiresAt: protocol.orderAuth.expiresAt,
      },
    );
    // A cancellation signature is a terminal maker decision. Persist the
    // exact proof before publishing it so every retry is byte-for-byte the
    // same after a timeout, disconnect, or process crash.
    state.upsert(managed);
  }
  return book.cancelSigned(
    managed.id,
    protocol.cancelProof,
    { order: protocol.order, auth: protocol.orderAuth },
    privateMakerToken(managed),
  );
}

async function publishFill(managed: ManagedOrder): Promise<OrderView> {
  const protocol = managed.protocol;
  if (protocol?.selectedIntent === undefined || protocol.fillProof === undefined) {
    throw new Error(`order ${short(managed.id)} has incomplete signed fill state`);
  }
  const filled = await book.fill(
    managed.id,
    protocol.fillProof,
    protocol.selectedIntent,
    { order: protocol.order, auth: protocol.orderAuth },
    privateMakerToken(managed),
  );
  persistAuthenticatedFillObservation(managed, filled);
  return filled;
}

function persistAuthenticatedFillObservation(
  managed: ManagedOrder,
  view: OrderView,
): void {
  const protocol = managed.protocol;
  if (
    protocol?.fillProof === undefined ||
    view.status !== "locking" ||
    view.fillDigest === undefined
  ) {
    return;
  }
  const fillAcknowledged = true;
  const releaseObserved = protocol.releaseObserved || view.released === true;
  if (
    protocol.fillAcknowledged === fillAcknowledged &&
    protocol.releaseObserved === releaseObserved
  ) {
    return;
  }

  // Stage acknowledgment on a clone. The live decision object changes only
  // after StateFile has durably committed it, so a failed write cannot grant
  // funding authority for this process tick.
  const staged = structuredClone(managed);
  if (staged.protocol === undefined) {
    throw new Error(`order ${short(managed.id)} lost its portable protocol state`);
  }
  staged.protocol.fillAcknowledged = fillAcknowledged;
  staged.protocol.releaseObserved = releaseObserved;
  state.upsert(staged);
  protocol.fillAcknowledged = fillAcknowledged;
  protocol.releaseObserved = releaseObserved;
}

async function publishSignedOrder(managed: ManagedOrder): Promise<OrderView> {
  const protocol = managed.protocol;
  if (protocol === undefined) throw new Error("portable order state is missing");
  if (managed.token === null) throw new Error("portable order maker capability is missing");
  const created = await book.createSigned({
    order: protocol.order,
    auth: protocol.orderAuth,
  }, managed.token);
  if (created.order.id !== managed.id) {
    throw new Error("signed order book response changed the deterministic order id");
  }
  managed.token = created.makerToken;
  state.upsert(managed);
  return created.order;
}

async function fetchBook(managed: ManagedOrder): Promise<{ status: BookStatus; view: OrderView | null }> {
  try {
    const protocol = managed.protocol;
    const view = protocol === undefined
      ? await book.get(managed.id)
      : await book.getSigned(
          managed.id,
          { order: protocol.order, auth: protocol.orderAuth },
          protocol.fillProof !== undefined && protocol.selectedIntent !== undefined
            ? { fill: protocol.fillProof, intent: protocol.selectedIntent }
            : protocol.cancelProof !== undefined
              ? { cancel: protocol.cancelProof }
              : undefined,
        );
    return { status: view.status, view };
  } catch (err) {
    if (err instanceof OrderGoneError) return { status: "gone", view: null };
    throw err; // network/book outage: skip this order this tick
  }
}

async function legStateOrNull(
  leg: LegRpc,
  hashlock: string,
  confirmed: boolean,
): Promise<LegState | null> {
  try {
    return confirmed
      ? await getConfirmedSwapState(leg, hashlock, cfg.confirmations)
      : await getSwapState(leg, hashlock);
  } catch {
    return null; // fail closed; decide() treats null as "not verified"
  }
}

async function advance(managed: ManagedOrder): Promise<OrderView | null> {
  const iLeg = initiatorLeg(managed.direction);
  const rLeg = responderLeg(managed.direction);
  const protocol = managed.protocol;
  let bookStatus: BookStatus = "locking";
  let view: OrderView | null = null;
  let bookError: unknown;
  try {
    const snapshot = await fetchBook(managed);
    bookStatus = snapshot.status;
    view = snapshot.view;
  } catch (error) {
    if (!(error instanceof OrderBookUnavailableError)) throw error;
    bookError = error;
  }
  if (view !== null) persistAuthenticatedFillObservation(managed, view);

  const hashlock = managed.hashlock;
  const [iState, rState, rConfirmed] = hashlock
    ? await Promise.all([
        legStateOrNull(legRpc[iLeg], hashlock, false),
        legStateOrNull(legRpc[rLeg], hashlock, false),
        legStateOrNull(legRpc[rLeg], hashlock, true),
      ])
    : [null, null, null];

  if (
    bookError !== undefined &&
    !canContinueWithoutBook(managed, iState)
  ) {
    throw bookError;
  }
  if (bookError !== undefined) {
    log(`order ${short(managed.id)} book unavailable; continuing from durable settlement state`);
  }
  let newLockBlockedByBook = false;

  if (
    protocol !== undefined &&
    protocol.orderAuth.expiresAt <= nowS() &&
    protocol.fillProof === undefined &&
    protocol.cancelProof === undefined &&
    !canContinueWithoutBook(managed, iState)
  ) {
    state.delete(managed.id);
    log(`portable order ${short(managed.id)} expired before a signed terminal decision`);
    return view;
  }

  // A signed listing is persisted before its first publish. A missing row
  // therefore means the prior create request never landed, and the exact
  // OrderV1 can be retried without minting another nonce or listing.
  if (
    bookStatus === "gone" &&
    protocol !== undefined &&
    protocol.selectedIntent === undefined &&
    protocol.fillProof === undefined &&
    protocol.cancelProof === undefined
  ) {
    if (protocol.orderAuth.expiresAt <= nowS()) {
      state.delete(managed.id);
      return null;
    }
    const published = await publishSignedOrder(managed);
    log(`recovered portable order ${short(managed.id)} with its original proof`);
    return published;
  }

  // Terminal protocol decisions take precedence over changing operator or
  // market conditions. Once persisted, publish the identical artifact on
  // every uncertain retry and never sign the opposite terminal action.
  if (protocol?.cancelProof !== undefined) {
    if (bookStatus === "cancelled") {
      state.delete(managed.id);
      return view;
    }
    if (bookStatus === "gone") return view;
    if (bookStatus !== "open") {
      throw new Error(`order ${short(managed.id)} conflicts with its signed cancellation`);
    }
    await book.cancelSigned(
      managed.id,
      protocol.cancelProof,
      { order: protocol.order, auth: protocol.orderAuth },
      privateMakerToken(managed),
    );
    state.delete(managed.id);
    log(`order ${short(managed.id)} signed cancellation published`);
    return view;
  }
  if (protocol?.fillProof !== undefined && bookStatus === "open") {
    try {
      const filled = await publishFill(managed);
      log(`order ${short(managed.id)} signed fill published`);
      return filled;
    } catch (error) {
      if (
        !(error instanceof OrderBookUnavailableError) ||
        !canContinueWithoutBook(managed, iState)
      ) {
        throw error;
      }
      newLockBlockedByBook = true;
      log(`order ${short(managed.id)} fill publication unavailable; continuing settlement checks`);
    }
  }

  // Drain is an explicit operator state: pull unfunded exposure from the
  // book, but keep every accepted or funded lifecycle under management
  // until it reaches its normal terminal state.
  if (cfg.drain && protocol?.fillProof === undefined) {
    try {
      const cancelled = await cancelOpenListing(
        true,
        bookStatus,
        () => cancelManaged(managed),
        (err) => err instanceof OrderGoneError,
      );
      if (cancelled) {
        state.delete(managed.id);
        log(`order ${short(managed.id)} cancelled for drain`);
        return view;
      }
    } catch (err) {
      log(
        `order ${short(managed.id)} drain cancel failed, keeping to retry:`,
        err instanceof Error ? err.message : err,
      );
      return view;
    }
  }

  // Reprice a still-open listing when ITS pair's mid drifted past the
  // threshold: cancel it and let refill repost the rung at the current
  // price. A null quotedMidMilli (pre-feed record) always reprices.
  if (bookStatus === "open" && protocol?.fillProof === undefined) {
    const mid = feed.current(nowS(), managed.asset);
    if (
      mid !== null &&
      (managed.quotedMidMilli === null ||
        needsReprice(BigInt(managed.quotedMidMilli), mid, cfg.repriceThresholdBps))
    ) {
      try {
        await cancelManaged(managed);
      } catch (err) {
        if (!(err instanceof OrderGoneError)) {
          // Cancel failed: keep the managed record so next tick retries,
          // rather than leaving a stale-priced ghost row open on the book
          // that a taker could take and then wait on forever.
          log(
            `order ${short(managed.id)} reprice cancel failed, keeping to retry:`,
            err instanceof Error ? err.message : err,
          );
          return view;
        }
      }
      state.delete(managed.id);
      log(
        `order ${short(managed.id)} repriced off the book (quoted mid ${managed.quotedMidMilli ?? "unknown"}, now ${mid})`,
      );
      return view;
    }
    // Liveness ping so the listing stays in the take-by-terms matchable
    // set; every tick is well inside the book's presence TTL.
    if (managed.token !== null) {
      await book.heartbeat(managed.id, managed.token).catch(() => undefined);
    }
  }

  // Portable listings use signed taker intents and a maker-signed FillV1.
  // The generated secret plus chosen intent reaches disk first. The exact
  // fill body and authorization then reaches disk before any network send.
  if (
    bookStatus === "open" &&
    protocol !== undefined &&
    protocol.fillProof === undefined
  ) {
    let selected = protocol.selectedIntent;
    if (selected !== undefined && protocol.fillProof === undefined && selected.auth.expiresAt <= nowS()) {
      delete protocol.selectedIntent;
      managed.preimage = null;
      managed.hashlock = null;
      managed.initiatorTimeout = null;
      managed.responderTimeout = null;
      managed.announcedAt = null;
      managed.takerEthAccount = null;
      managed.takerQrlAccount = null;
      state.upsert(managed);
      selected = undefined;
    }
    if (selected === undefined) {
      const candidates = await book.intents(managed.id);
      const selectedNow = earliestValidFillIntent(
        candidates,
        protocol.orderDigest,
        nowS(),
        (candidate) =>
          verifyFillIntentV1(candidate.intent, candidate.auth, protocol.orderDigest, {
            now: nowS(),
            orderIssuedAt: protocol.orderAuth.issuedAt,
            orderExpiresAt: protocol.orderAuth.expiresAt,
          }),
      );
      if (selectedNow === null) return view;

      const secret = newSecret();
      const selectedAt = nowS();
      managed.preimage = secret.preimage;
      managed.hashlock = secret.hashlock;
      managed.initiatorTimeout = selectedAt + cfg.initiatorWindowS;
      managed.responderTimeout = selectedAt + cfg.responderWindowS;
      managed.announcedAt = selectedAt;
      managed.takerEthAccount = selectedNow.intent.takerEthAccount;
      managed.takerQrlAccount = selectedNow.intent.takerQrlAccount;
      protocol.selectedIntent = selectedNow;
      state.upsert(managed);
      selected = selectedNow;
    }

    if (protocol.fillProof === undefined) {
      const issuedAt = nowS();
      if (issuedAt >= selected.auth.expiresAt) return view;
      const responseWindowS = Math.min(
        FILL_RESPONSE_TARGET_S,
        cfg.responderWindowS - 601,
      );
      if (responseWindowS < 60) {
        throw new Error("responder window is too short for a portable fill");
      }
      const respondBy = Math.min(
        issuedAt + responseWindowS,
        protocol.orderAuth.expiresAt,
      );
      if (respondBy - issuedAt < 60) {
        const cancelled = await cancelManaged(managed);
        state.delete(managed.id);
        log(`order ${short(managed.id)} cancelled before fill: signed order expiry is too near`);
        return cancelled;
      }
      if (
        managed.hashlock === null ||
        managed.initiatorTimeout === null ||
        managed.responderTimeout === null
      ) {
        throw new Error(`order ${short(managed.id)} lost its persisted fill terms`);
      }
      protocol.fillProof = protocolSigner.signFillV1(
        {
          orderDigest: protocol.orderDigest,
          intentDigest: selected.intentDigest,
          takerEthAccount: selected.intent.takerEthAccount,
          takerQrlAccount: selected.intent.takerQrlAccount,
          releaseCommitment: selected.intent.releaseCommitment,
          hashlock: managed.hashlock,
          initiatorTimeout: managed.initiatorTimeout,
          responderTimeout: managed.responderTimeout,
        },
        {
          order: { order: protocol.order, auth: protocol.orderAuth },
          selectedIntent: selected,
          issuedAt,
          respondBy,
        },
      );
      state.upsert(managed);
    }
    const filled = await publishFill(managed);
    log(`order ${short(managed.id)} selected the earliest valid signed intent`);
    return filled;
  }

  // A persisted FillV1 is the portable coordination record. Once signed,
  // its lifecycle remains locking even if this mirror disappears or lies
  // about terminal status. Chain state and the local proof take over.
  const lifecycleBookStatus: BookStatus =
    protocol?.fillProof === undefined ? bookStatus : "locking";
  const fillResponseExpired =
    protocol?.fillProof !== undefined && nowS() >= protocol.fillProof.auth.expiresAt;
  const decision = decide({
    bookStatus: lifecycleBookStatus,
    released: Boolean(view?.released) || fillResponseExpired,
    managed,
    iState,
    rState,
    rConfirmed,
    expectedRecipient: myAddress(rLeg),
    expectedAmountWei: BigInt(managed.toAmount),
    // We receive the order's ETH-leg asset only when the taker locks the
    // ETH leg (direction qrl->eth); the QRL leg is always native. The
    // address comes from the compiled-in registry, never from the book.
    expectedToken:
      rLeg === "eth" ? (assetInfo(managed.asset).tokenAddress ?? NATIVE_TOKEN) : NATIVE_TOKEN,
    nowS: nowS(),
    resendAfterS: cfg.resendAfterS,
    claimSafetyS: cfg.claimSafetyS,
    lockGraceS: cfg.lockGraceS,
  });

  switch (decision) {
    case "wait":
      break;

    case "announce": {
      if (protocol !== undefined) {
        throw new Error(`portable order ${short(managed.id)} entered the legacy accepted state`);
      }
      if (view === null) break;
      if (managed.preimage === null || managed.hashlock === null) {
        // Crash safety: the secret hits disk before the book ever sees
        // the hashlock, mirroring the frontend maker flow.
        const secret = newSecret();
        managed.preimage = secret.preimage;
        managed.hashlock = secret.hashlock;
        state.upsert(managed);
      }
      const t1 = nowS() + cfg.initiatorWindowS;
      const t2 = nowS() + cfg.responderWindowS;
      const announced = await book.announceHashlock(managed.id, {
        token: requireMakerToken(managed),
        hashlock: managed.hashlock,
        initiatorTimeout: t1,
        responderTimeout: t2,
      });
      // Taker addresses come from the announce response, not the earlier
      // view: the pairing is only frozen once the order is locking, and a
      // release + re-accept in between could have swapped takers.
      managed.takerEthAccount = announced.takerEthAccount ?? view.takerEthAccount;
      managed.takerQrlAccount = announced.takerQrlAccount ?? view.takerQrlAccount;
      managed.initiatorTimeout = t1;
      managed.responderTimeout = t2;
      managed.announcedAt = nowS();
      state.upsert(managed);
      log(`order ${short(managed.id)} taken; hashlock announced, t2 in ${cfg.responderWindowS}s`);
      break;
    }

    case "lock": {
      if (newLockBlockedByBook) break;
      const recipient = iLeg === "eth" ? managed.takerEthAccount : managed.takerQrlAccount;
      if (!recipient || managed.hashlock === null || managed.initiatorTimeout === null) break;
      // Final walk-away check against a release that landed since the tick's
      // book read. An acknowledged portable fill may keep progressing during
      // a coordination outage because its exact terminal proof is durable.
      let fresh: Awaited<ReturnType<typeof fetchBook>> | null = null;
      try {
        fresh = await fetchBook(managed);
      } catch (error) {
        if (!(error instanceof OrderBookUnavailableError)) throw error;
        if (!canContinueWithoutBook(managed, iState)) throw error;
      }
      if (fresh !== null && fresh.view !== null) {
        persistAuthenticatedFillObservation(managed, fresh.view);
      }
      if (
        (protocol?.fillProof !== undefined && nowS() >= protocol.fillProof.auth.expiresAt) ||
        protocol?.releaseObserved === true ||
        fresh?.view?.released ||
        (protocol?.fillProof !== undefined &&
          managed.lockSentAt === null &&
          fresh !== null &&
          fresh.status !== "locking") ||
        (protocol === undefined &&
          fresh !== null &&
          (fresh.status === "gone" || fresh.status === "cancelled"))
      ) {
        log(`order ${short(managed.id)} not locking: response window closed or taker released`);
        break;
      }
      const token = iLeg === "eth" ? assetInfo(managed.asset).tokenAddress : null;
      if (token !== null) {
        // ERC-20 leg: exact-amount approve, then lockToken with value 0.
        // The allowance read happens before lockSentAt is persisted (it is
        // just a read); the sends happen after, exactly like the native
        // path, so a crash mid-sequence never double-spends: on resume an
        // allowance already equal to the amount skips the approve, and a
        // landed lockToken flips iState so decide() never re-locks.
        const amount = BigInt(managed.fromAmount);
        const allowance = await erc20Allowance(legRpc.eth, token, eth.address, cfg.ethHtlc);
        managed.lockSentAt = nowS();
        state.upsert(managed);
        if (allowance !== amount) {
          if (allowance !== 0n && assetInfo(managed.asset).quirks.approvalRace) {
            // USDT-style tokens revert on nonzero -> nonzero approve;
            // reset to 0 first and wait for it to land.
            await eth.send(encodeApprove(cfg.ethHtlc, 0n), 0n, token);
          }
          await eth.send(encodeApprove(cfg.ethHtlc, amount), 0n, token);
        }
        const hash = await eth.send(
          encodeLockToken(managed.hashlock, recipient, token, amount, managed.initiatorTimeout),
          0n,
        );
        log(`order ${short(managed.id)} locked ${managed.asset} on ${iLeg} leg, tx ${hash}`);
        break;
      }
      managed.lockSentAt = nowS();
      state.upsert(managed);
      const hash = await sender(iLeg).send(
        encodeLock(managed.hashlock, recipient, managed.initiatorTimeout),
        BigInt(managed.fromAmount),
      );
      log(`order ${short(managed.id)} locked ${iLeg} leg, tx ${hash}`);
      break;
    }

    case "claim": {
      if (managed.hashlock === null || managed.preimage === null) break;
      const claimData = encodeClaim(managed.hashlock, managed.preimage);
      // A reverted claim rolls the HTLC state back to Open while calldata
      // may expose the preimage. Simulate the exact transaction from the
      // actual sender against latest state immediately before submission,
      // and fail closed on every RPC/EVM error. Issuer policy or other
      // chain state can still change between this check and mining, so the
      // timeout safety margin remains required.
      const hash = await submitPreflightedClaim(
        legRpc[rLeg],
        myAddress(rLeg),
        claimData,
        async () => {
          managed.claimSentAt = nowS();
          state.upsert(managed);
          return sender(rLeg).send(claimData, 0n);
        },
      );
      log(`order ${short(managed.id)} claimed ${rLeg} leg (secret revealed), tx ${hash}`);
      break;
    }

    case "refund": {
      if (managed.hashlock === null) break;
      managed.refundSentAt = nowS();
      state.upsert(managed);
      const hash = await sender(iLeg).send(encodeRefund(managed.hashlock), 0n);
      log(`order ${short(managed.id)} refunded ${iLeg} leg (taker never finished), tx ${hash}`);
      break;
    }

    case "finish":
    case "abort": {
      if (decision === "abort" && bookStatus !== "gone" && bookStatus !== "cancelled") {
        try {
          if (protocol?.fillProof === undefined) {
            await cancelManaged(managed);
          }
        } catch (err) {
          if (!(err instanceof OrderGoneError)) {
            // Keep the record and retry the cancel next tick instead of
            // orphaning a live listing no maker will service.
            log(
              `order ${short(managed.id)} abort cancel failed, keeping to retry:`,
              err instanceof Error ? err.message : err,
            );
            break;
          }
        }
      }
      state.delete(managed.id);
      log(`order ${short(managed.id)} ${decision === "finish" ? "settled" : "dropped"}`);
      break;
    }
  }
  return view;
}

async function refill(views: Map<string, OrderView | null>): Promise<void> {
  if (cfg.drain) return;
  const managed = state.all();
  const inflight = managed.filter((m) => {
    const v = views.get(m.id);
    return (
      m.lockSentAt !== null ||
      m.protocol?.fillProof !== undefined ||
      (v !== null && v !== undefined && (v.status === "accepted" || v.status === "locking"))
    );
  }).length;

  const balances: Record<LegKey, bigint> = {
    eth: await eth.balance(),
    qrl: await qrl.balance(),
  };
  const tokenBalances = new Map<AssetSymbol, bigint>();
  for (const symbol of cfg.assets) {
    const address = assetInfo(symbol).tokenAddress;
    if (address !== null) {
      tokenBalances.set(symbol, await erc20BalanceOf(legRpc.eth, address, eth.address));
    }
  }

  for (const asset of cfg.assets) {
    const info = assetInfo(asset);
    const policy = cfg.assetPolicies.get(asset);
    if (policy === undefined) continue; // loadConfig builds one per asset

    // Never quote blind, per pair: no fresh mid for this asset, no new
    // listings for it. Existing swaps keep settling; the pair's book
    // thins out until its feed recovers.
    const mid = feed.current(nowS(), asset);
    if (mid === null) continue;

    for (const direction of ["eth->qrl", "qrl->eth"] as const) {
      const fromLeg = initiatorLeg(direction);
      // Refill the lowest under-stocked rung of the pair's price ladder
      // (one per tick, per pair and direction, so a taken level reappears
      // gradually). Each rung carries up to ordersPerLevel identical
      // listings so concurrent takers can run the same trade side by side.
      const openByLevel = new Map<number, number>();
      for (const m of managed) {
        if (m.direction !== direction || m.asset !== asset) continue;
        const knownView = views.get(m.id);
        // An unknown row may be a persisted signed create whose response
        // was lost. Reserve its rung until advance() resolves or retries it
        // so an outage cannot make the bot mint duplicate listings.
        if (knownView !== undefined && knownView?.status !== "open") continue;
        openByLevel.set(m.level, (openByLevel.get(m.level) ?? 0) + 1);
      }
      let myOpenCount = 0;
      for (const count of openByLevel.values()) myOpenCount += count;
      let level = -1;
      for (let l = 0; l < policy.ordersPerDirection; l += 1) {
        if ((openByLevel.get(l) ?? 0) < cfg.ordersPerLevel) {
          level = l;
          break;
        }
      }
      if (level < 0) continue;

      const quote = levelQuote({
        direction,
        level,
        baseUnits: policy.baseUnits,
        midPriceMilli: mid,
        stepBps: cfg.levelStepBps,
        assetDecimals: info.decimals,
      });
      // From-side inventory is the asset's ERC-20 balance when the maker
      // escrows a token, native coin otherwise. The ETH native balance is
      // always the gas budget for a token pair's ETH-leg actions (approve,
      // lockToken, claim), so it must hold its reserve even when the
      // listed inventory is a token.
      const fromToken = direction === "eth->qrl" && info.tokenAddress !== null;
      const balanceWei = fromToken ? (tokenBalances.get(asset) ?? 0n) : balances[fromLeg];
      const reserveWei = fromToken
        ? policy.reserveUnits
        : fromLeg === "eth"
          ? cfg.ethReserveWei
          : cfg.qrlReserveWei;
      const [gasBalanceWei, gasReserveWei] =
        info.tokenAddress !== null ? [balances.eth, cfg.ethReserveWei] : [balanceWei, reserveWei];
      const post = shouldPost({
        direction,
        myOpenCount,
        ordersPerDirection: policy.ordersPerDirection,
        ordersPerLevel: cfg.ordersPerLevel,
        inflightCount: inflight,
        maxInflight: cfg.maxInflight,
        balanceWei,
        reserveWei,
        orderWei: BigInt(quote.fromAmount),
        gasBalanceWei,
        gasReserveWei,
      });
      if (!post) continue;

      const makerToken = randomBytes(32).toString("hex");
      const signed = protocolSigner.signOrderV1(
        {
          direction,
          asset,
          fromAmount: quote.fromAmount,
          toAmount: quote.toAmount,
          makerEthAccount: eth.address,
          makerQrlAccount: qrl.address,
        },
        { makerToken },
      );
      const orderDigest = computeOrderDigest(signed.order, signed.auth);
      const pending: ManagedOrder = {
        id: deriveOrderV1Id(signed.order.makerQrlAccount, signed.auth.nonce),
        deployment,
        token: makerToken,
        protocol: {
          version: 1,
          orderDigest,
          order: signed.order,
          orderAuth: signed.auth,
          fillAcknowledged: false,
          releaseObserved: false,
        },
        direction,
        asset,
        level,
        quotedMidMilli: mid.toString(),
        fromAmount: quote.fromAmount,
        toAmount: quote.toAmount,
        preimage: null,
        hashlock: null,
        initiatorTimeout: null,
        responderTimeout: null,
        announcedAt: null,
        takerEthAccount: null,
        takerQrlAccount: null,
        lockSentAt: null,
        claimSentAt: null,
        refundSentAt: null,
        createdAt: nowS(),
      };
      // Persist the signed listing before publish. Maker identity plus nonce
      // form its stable id, so a timed-out create retries the exact artifact.
      state.upsert(pending);
      const order = await publishSignedOrder(pending);
      log(
        `posted ${direction} ${asset} L${level} order ${short(order.id)} (${quote.fromAmount} -> ${quote.toAmount})`,
      );
    }
  }
}

let running = false;
let stopping = false;
let tickTimer: ReturnType<typeof setInterval> | undefined;
let healthServer: Server | undefined;

async function tick(): Promise<void> {
  if (running || stopping) return;
  running = true;
  const startingOrderCount = state.all().length;
  health.markTickStarted(startingOrderCount);
  let errorCount = 0;
  try {
    await feed.maybeRefresh(nowS());
    const views = new Map<string, OrderView | null>();
    for (const managed of state.all()) {
      try {
        views.set(managed.id, await advance(managed));
      } catch (err) {
        if (err instanceof StateFilePoisonedError) throw err;
        errorCount += 1;
        log(`order ${short(managed.id)} tick error:`, err instanceof Error ? err.message : err);
      }
    }
    await refill(views);
  } catch (err) {
    errorCount += 1;
    log("tick error:", err instanceof Error ? err.message : err);
    if (err instanceof StateFilePoisonedError) {
      void stop("state durability failure", 1);
    }
  } finally {
    let orderCount = startingOrderCount;
    try {
      orderCount = state.all().length;
    } catch {
      // A poisoned state file is already forcing process shutdown.
    }
    health.markTickCompleted(orderCount, errorCount);
    running = false;
  }
}

async function main(): Promise<void> {
  if (protocolSigner.address.toLowerCase() !== qrl.address.toLowerCase()) {
    throw new Error("protocol signer address does not match the QRL transaction signer");
  }
  assertPortableDeployment();
  for (const managed of state.all()) {
    const order = managed.protocol?.order;
    if (
      order !== undefined &&
      (order.makerEthAccount.toLowerCase() !== eth.address.toLowerCase() ||
        order.makerQrlAccount.toLowerCase() !== protocolSigner.address.toLowerCase())
    ) {
      throw new Error(
        `portable order ${short(managed.id)} belongs to different operator keys`,
      );
    }
  }
  healthServer = await listenHealthServer(health, cfg.healthHost, cfg.healthPort);
  log(`health endpoint listening on ${cfg.healthHost}:${cfg.healthPort}`);
  const [ethRpcChainId, qrlRpcChainId] = await Promise.all([
    getChainId(legRpc.eth),
    getChainId(legRpc.qrl),
  ]);
  assertRuntimeChainIds(deployment, ethRpcChainId, qrlRpcChainId);
  health.markRuntimeVerified();
  if (cfg.drain) log("drain mode active: cancelling open listings and posting no replacements");
  log(`maker eth=${eth.address} qrl=${qrl.address}`);
  log(
    `deployment ${deployment.configFingerprint} | ` +
      `chains ${deployment.ethChainId}/${deployment.qrlChainId} | ` +
      `HTLCs ${deployment.ethHtlc}/${deployment.qrlHtlc}`,
  );
  log(
    `balances eth=${await eth.balance()} qrl=${await qrl.balance()} | ` +
      `max inflight ${cfg.maxInflight}, ${cfg.ordersPerLevel} listing(s)/rung, ` +
      `price ${cfg.priceFeed === "off" ? `static ${cfg.midPriceMilli} milli (ETH pair only)` : `${cfg.priceFeed} feed, reprice > ${cfg.repriceThresholdBps} bps drift`}`,
  );
  for (const asset of cfg.assets) {
    const info = assetInfo(asset);
    const policy = cfg.assetPolicies.get(asset);
    if (policy === undefined) continue;
    const inventory =
      info.tokenAddress === null
        ? "native"
        : `${await erc20BalanceOf(legRpc.eth, info.tokenAddress, eth.address)} base units`;
    log(
      `pair QRL/${asset}: inventory ${inventory}, ${policy.ordersPerDirection} rung(s) per direction, ` +
        `base size ${policy.baseUnits}, reserve ${policy.reserveUnits} (base units)`,
    );
  }
  log(`managing ${state.all().length} persisted order(s)`);
  await tick();
  if (!stopping) tickTimer = setInterval(() => void tick(), cfg.tickMs);
}

async function stop(reason: string, exitCode: number): Promise<void> {
  if (stopping) return;
  stopping = true;
  process.exitCode = exitCode;
  if (tickTimer !== undefined) clearInterval(tickTimer);
  log(`stopping (${reason})`);
  while (running) {
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  protocolSigner.close();
  if (healthServer !== undefined) {
    await new Promise<void>((resolve) => healthServer?.close(() => resolve()));
  }
  stateLease.close();
}

process.once("SIGTERM", () => void stop("SIGTERM", 0));
process.once("SIGINT", () => void stop("SIGINT", 0));

main().catch((err) => {
  console.error("[mm] fatal:", err);
  void stop("fatal error", 1);
});
