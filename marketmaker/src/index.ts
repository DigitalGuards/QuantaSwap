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
import { loadConfig, type Config } from "./config.js";
import { EthLeg, QrlLeg } from "./chains.js";
import {
  encodeClaim,
  encodeLock,
  encodeRefund,
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
const book = new OrderBookClient(cfg.orderbookUrl);
const state = new StateFile(cfg.stateFile);
const eth = new EthLeg(cfg);
const qrl = new QrlLeg(cfg);

const legRpc: Record<LegKey, LegRpc> = {
  eth: { url: cfg.ethRpcUrl, ns: "eth", htlc: cfg.ethHtlc },
  qrl: { url: cfg.qrlRpcUrl, ns: "qrl", htlc: cfg.qrlHtlc },
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

  // Reprice a still-open listing when the mid drifted past the threshold:
  // cancel it and let refill repost the rung at the current price. A null
  // quotedMidMilli (pre-feed record) always reprices.
  if (bookStatus === "open") {
    const mid = feed.current(nowS());
    if (
      mid !== null &&
      (managed.quotedMidMilli === null ||
        needsReprice(BigInt(managed.quotedMidMilli), mid, cfg.repriceThresholdBps))
    ) {
      await book.cancel(managed.id, managed.token).catch(() => undefined);
      state.delete(managed.id);
      log(
        `order ${short(managed.id)} repriced off the book (quoted mid ${managed.quotedMidMilli ?? "unknown"}, now ${mid})`,
      );
      return view;
    }
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
    managed,
    iState,
    rState,
    rConfirmed,
    expectedRecipient: myAddress(rLeg),
    expectedAmountWei: BigInt(managed.toAmount),
    nowS: nowS(),
    resendAfterS: cfg.resendAfterS,
    claimSafetyS: cfg.claimSafetyS,
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
      state.upsert(managed);
      log(`order ${short(managed.id)} taken; hashlock announced, t2 in ${cfg.responderWindowS}s`);
      break;
    }

    case "lock": {
      const recipient = iLeg === "eth" ? managed.takerEthAccount : managed.takerQrlAccount;
      if (!recipient || managed.hashlock === null || managed.initiatorTimeout === null) break;
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
        await book.cancel(managed.id, managed.token).catch(() => undefined);
      }
      state.delete(managed.id);
      log(`order ${short(managed.id)} ${decision === "finish" ? "settled" : "dropped"}`);
      break;
    }
  }
  return view;
}

async function refill(views: Map<string, OrderView | null>): Promise<void> {
  const mid = feed.current(nowS());
  if (mid === null) {
    // Never quote blind: no fresh price, no new listings. Existing swaps
    // keep settling; the book thins out until the feed recovers.
    return;
  }
  const managed = state.all();
  const inflight = managed.filter((m) => {
    const v = views.get(m.id);
    return v !== null && v !== undefined && (v.status === "accepted" || v.status === "locking");
  }).length;

  const balances: Record<LegKey, bigint> = {
    eth: await eth.balance(),
    qrl: await qrl.balance(),
  };

  for (const direction of ["eth->qrl", "qrl->eth"] as const) {
    const fromLeg = initiatorLeg(direction);
    // Refill the lowest missing rung of the price ladder (one per tick,
    // per direction, so a taken level reappears gradually).
    const openLevels = new Set(
      managed
        .filter((m) => m.direction === direction && views.get(m.id)?.status === "open")
        .map((m) => m.level),
    );
    let level = -1;
    for (let l = 0; l < cfg.ordersPerDirection; l += 1) {
      if (!openLevels.has(l)) {
        level = l;
        break;
      }
    }
    if (level < 0) continue;

    const quote = levelQuote({
      direction,
      level,
      baseEthWei: cfg.ethOrderWei,
      midPriceMilli: mid,
      stepBps: cfg.levelStepBps,
    });
    const post = shouldPost({
      direction,
      myOpenCount: openLevels.size,
      ordersPerDirection: cfg.ordersPerDirection,
      inflightCount: inflight,
      maxInflight: cfg.maxInflight,
      balanceWei: balances[fromLeg],
      reserveWei: fromLeg === "eth" ? cfg.ethReserveWei : cfg.qrlReserveWei,
      orderWei: BigInt(quote.fromAmount),
    });
    if (!post) continue;

    const { order, makerToken } = await book.create({
      direction,
      fromAmount: quote.fromAmount,
      toAmount: quote.toAmount,
      makerEthAccount: eth.address,
      makerQrlAccount: qrl.address,
    });
    state.upsert({
      id: order.id,
      token: makerToken,
      direction,
      level,
      quotedMidMilli: mid.toString(),
      fromAmount: quote.fromAmount,
      toAmount: quote.toAmount,
      preimage: null,
      hashlock: null,
      initiatorTimeout: null,
      responderTimeout: null,
      takerEthAccount: null,
      takerQrlAccount: null,
      lockSentAt: null,
      claimSentAt: null,
      refundSentAt: null,
      createdAt: nowS(),
    });
    log(
      `posted ${direction} L${level} order ${short(order.id)} (${quote.fromAmount} -> ${quote.toAmount})`,
    );
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
      `target ${cfg.ordersPerDirection}/direction, max inflight ${cfg.maxInflight}, ` +
      `base size ${cfg.ethOrderWei} wei ETH, price ${cfg.priceFeed === "off" ? `static ${cfg.midPriceMilli} milli` : `${cfg.priceFeed} feed, reprice > ${cfg.repriceThresholdBps} bps drift`}`,
  );
  log(`managing ${state.all().length} persisted order(s)`);
  await tick();
  setInterval(() => void tick(), cfg.tickMs);
}

main().catch((err) => {
  console.error("[mm] fatal:", err);
  process.exit(1);
});
