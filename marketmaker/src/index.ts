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
import { assetInfo, type AssetSymbol } from "./assets.js";
import { loadConfig, type Config } from "./config.js";
import { EthLeg, QrlLeg } from "./chains.js";
import {
  NATIVE_TOKEN,
  encodeApprove,
  encodeClaim,
  encodeLock,
  encodeLockToken,
  encodeRefund,
  erc20Allowance,
  erc20BalanceOf,
  getConfirmedSwapState,
  getSwapState,
  type LegKey,
  type LegRpc,
  type LegState,
} from "./htlc.js";
import { OrderBookClient, OrderGoneError, type OrderView } from "./orderbook.js";
import { COINGECKO_URL, PriceFeed, needsReprice } from "./price.js";
import {
  decide,
  levelQuote,
  shouldPost,
  type BookStatus,
  type Direction,
  type ManagedOrder,
} from "./policy.js";
import { StateFile } from "./state.js";

const cfg: Config = loadConfig();
const book = new OrderBookClient(cfg.orderbookUrl, cfg.netTimeoutMs);
const state = new StateFile(cfg.stateFile);
const eth = new EthLeg(cfg);
const qrl = new QrlLeg(cfg);

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

async function fetchBook(id: string): Promise<{ status: BookStatus; view: OrderView | null }> {
  try {
    const view = await book.get(id);
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
  const { status: bookStatus, view } = await fetchBook(managed.id);

  // Reprice a still-open listing when ITS pair's mid drifted past the
  // threshold: cancel it and let refill repost the rung at the current
  // price. A null quotedMidMilli (pre-feed record) always reprices.
  if (bookStatus === "open") {
    const mid = feed.current(nowS(), managed.asset);
    if (
      mid !== null &&
      (managed.quotedMidMilli === null ||
        needsReprice(BigInt(managed.quotedMidMilli), mid, cfg.repriceThresholdBps))
    ) {
      try {
        await book.cancel(managed.id, managed.token);
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
    await book.heartbeat(managed.id, managed.token).catch(() => undefined);
  }

  const hashlock = managed.hashlock;
  const [iState, rState, rConfirmed] = hashlock
    ? await Promise.all([
        legStateOrNull(legRpc[iLeg], hashlock, false),
        legStateOrNull(legRpc[rLeg], hashlock, false),
        legStateOrNull(legRpc[rLeg], hashlock, true),
      ])
    : [null, null, null];

  const decision = decide({
    bookStatus,
    released: Boolean(view?.released),
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
        token: managed.token,
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
      const recipient = iLeg === "eth" ? managed.takerEthAccount : managed.takerQrlAccount;
      if (!recipient || managed.hashlock === null || managed.initiatorTimeout === null) break;
      // Final walk-away check against a release that landed since the tick's
      // book read: the book is on localhost so this is cheap, and it closes
      // most of the announce-to-lock grief window. Chain state still governs
      // if a release still slips in after we broadcast.
      const fresh = await fetchBook(managed.id);
      if (fresh.status === "gone" || fresh.status === "cancelled" || fresh.view?.released) {
        log(`order ${short(managed.id)} not locking: taker walked away before broadcast`);
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
      managed.claimSentAt = nowS();
      state.upsert(managed);
      const hash = await sender(rLeg).send(encodeClaim(managed.hashlock, managed.preimage), 0n);
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
          await book.cancel(managed.id, managed.token);
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
  const managed = state.all();
  const inflight = managed.filter((m) => {
    const v = views.get(m.id);
    return v !== null && v !== undefined && (v.status === "accepted" || v.status === "locking");
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
        if (views.get(m.id)?.status !== "open") continue;
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

      const { order, makerToken } = await book.create({
        direction,
        asset,
        fromAmount: quote.fromAmount,
        toAmount: quote.toAmount,
        makerEthAccount: eth.address,
        makerQrlAccount: qrl.address,
      });
      state.upsert({
        id: order.id,
        token: makerToken,
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
      });
      log(
        `posted ${direction} ${asset} L${level} order ${short(order.id)} (${quote.fromAmount} -> ${quote.toAmount})`,
      );
    }
  }
}

let running = false;

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await feed.maybeRefresh(nowS());
    const views = new Map<string, OrderView | null>();
    for (const managed of state.all()) {
      try {
        views.set(managed.id, await advance(managed));
      } catch (err) {
        log(`order ${short(managed.id)} tick error:`, err instanceof Error ? err.message : err);
      }
    }
    await refill(views);
  } catch (err) {
    log("tick error:", err instanceof Error ? err.message : err);
  } finally {
    running = false;
  }
}

async function main(): Promise<void> {
  log(`maker eth=${eth.address} qrl=${qrl.address}`);
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
  setInterval(() => void tick(), cfg.tickMs);
}

main().catch((err) => {
  console.error("[mm] fatal:", err);
  process.exit(1);
});
