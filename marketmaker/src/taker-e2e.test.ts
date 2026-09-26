// Offline end to end coverage for the scripted taker. A real HTTP order
// book, real ML-DSA-87 proofs from a scripted maker, real JSON-RPC
// endpoints over an in-memory HTLC with block history, and the real
// engine: only the transaction transport is substituted, so the verify,
// fund, claim and refund paths run exactly as they do live.

import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { assetInfo } from "./assets.js";
import { makeDeploymentIdentity } from "./deployment.js";
import {
  SwapStatus,
  encodeClaim,
  encodeLock,
  encodeRefund,
  type LegKey,
  type LegRpc,
} from "./htlc.js";
import { protocolV2Config } from "./protocol-v2-config.js";
import { ProtocolSigner } from "./protocol-signing.js";
import { V2_TEST_EXTENDED_SEED } from "./protocol-v2-test-helper.js";
import type { TakerReadConfig } from "./taker-config.js";
import { TakerBookClient } from "./taker-orderbook.js";
import { TakerEngine } from "./taker.js";
import { TakerStateFile, type TakerSwapRecord } from "./taker-state.js";
import {
  FakeBookServer,
  FakeHtlcChain,
  FakeLegSender,
  ScriptedMaker,
  startFakeChainRpc,
  type FakeEndpoint,
} from "./taker-test-harness.js";

const MAKER_SEED = V2_TEST_EXTENDED_SEED;
const TAKER_SEED = `0x010000${"09".repeat(48)}`;
const MAKER_ETH = `0x${"a".repeat(40)}`;
const TAKER_ETH = `0x${"c".repeat(40)}`;
const DEPLOYMENT = makeDeploymentIdentity(protocolV2Config);
const START = 1_800_000_000;

interface Harness {
  now: number;
  clock: () => number;
  book: FakeBookServer;
  chains: Record<LegKey, FakeHtlcChain>;
  rpc: Record<LegKey, FakeEndpoint>;
  legRpc: Record<LegKey, LegRpc>;
  cfg: TakerReadConfig;
  taker: ProtocolSigner;
  maker: ScriptedMaker;
  makerSenders: Record<LegKey, FakeLegSender>;
  takerSenders: Record<LegKey, FakeLegSender>;
  state: TakerStateFile;
  engine: TakerEngine;
  advance(seconds: number): void;
  mine(count?: number): void;
  close(): Promise<void>;
}

async function harness(options: {
  direction: "eth->qrl" | "qrl->eth";
  asset?: "ETH" | "USDC";
  fromAmount?: string;
  toAmount?: string;
  dryRun?: boolean;
  takerSenderFactory?: (
    leg: LegKey,
    chain: FakeHtlcChain,
    address: string,
  ) => FakeLegSender;
}): Promise<Harness> {
  const state = { now: START };
  const clock = (): number => state.now;
  const book = new FakeBookServer(clock);
  await book.start();
  const chains: Record<LegKey, FakeHtlcChain> = {
    eth: new FakeHtlcChain("eth", protocolV2Config.ethHtlc, clock),
    qrl: new FakeHtlcChain("qrl", protocolV2Config.qrlHtlc, clock),
  };
  const rpc: Record<LegKey, FakeEndpoint> = {
    eth: await startFakeChainRpc(chains.eth),
    qrl: await startFakeChainRpc(chains.qrl),
  };
  const asset = options.asset ?? "ETH";
  const taker = new ProtocolSigner(TAKER_SEED);
  const maker = new ScriptedMaker(
    MAKER_SEED,
    book,
    {
      direction: options.direction,
      asset,
      fromAmount: options.fromAmount ?? (2n * 10n ** 16n).toString(),
      toAmount: options.toAmount ?? (2n * 10n ** 18n).toString(),
      makerEthAccount: MAKER_ETH,
    },
    clock,
  );
  const makerSenders: Record<LegKey, FakeLegSender> = {
    eth: new FakeLegSender(MAKER_ETH, chains.eth),
    qrl: new FakeLegSender(maker.qrlAccount, chains.qrl),
  };
  const build =
    options.takerSenderFactory ??
    ((_leg: LegKey, chain: FakeHtlcChain, address: string) =>
      new FakeLegSender(address, chain));
  const takerSenders: Record<LegKey, FakeLegSender> = {
    eth: build("eth", chains.eth, TAKER_ETH),
    qrl: build("qrl", chains.qrl, taker.address),
  };
  const legRpc: Record<LegKey, LegRpc> = {
    eth: { url: rpc.eth.url, ns: "eth", htlc: protocolV2Config.ethHtlc, timeoutMs: 5_000 },
    qrl: { url: rpc.qrl.url, ns: "qrl", htlc: protocolV2Config.qrlHtlc, timeoutMs: 5_000 },
  };
  const stateFile = join(
    mkdtempSync(join(tmpdir(), "quantaswap-taker-e2e-")),
    "state.json",
  );
  const cfg: TakerReadConfig = {
    orderbookUrl: book.url,
    ethRpcUrl: rpc.eth.url,
    qrlRpcUrl: rpc.qrl.url,
    ethChainId: protocolV2Config.ethChainId,
    qrlChainId: protocolV2Config.qrlChainId,
    ethHtlc: protocolV2Config.ethHtlc,
    qrlHtlc: protocolV2Config.qrlHtlc,
    confirmations: 1,
    netTimeoutMs: 5_000,
    txTimeoutMs: 5_000,
    pollMs: 1,
    resendAfterS: 240,
    claimSafetyS: 600,
    lockRunwayS: 900,
    minOrderRunwayS: 900,
    ethGasReserveWei: 10n ** 15n,
    qrlGasReserveWei: 10n ** 15n,
    stateFile,
  };
  const takerState = new TakerStateFile(stateFile, DEPLOYMENT);
  const logs: unknown[][] = [];
  const engine = new TakerEngine({
    cfg,
    book: new TakerBookClient(cfg.orderbookUrl, cfg.netTimeoutMs),
    legRpc,
    signing: {
      signer: taker,
      eth: takerSenders.eth,
      qrl: takerSenders.qrl,
      state: takerState,
      deployment: DEPLOYMENT,
    },
    now: clock,
    log: (...args: unknown[]) => logs.push(args),
    sleep: async () => undefined,
    ...(options.dryRun === true ? { dryRun: true } : {}),
  });
  // Token pairs need inventory on the leg the taker escrows from.
  const tokenAddress = assetInfo(asset).tokenAddress;
  if (tokenAddress !== null) {
    chains.eth.balances.set(TAKER_ETH.toLowerCase(), 10n ** 12n);
  }
  return {
    get now() {
      return state.now;
    },
    clock,
    book,
    chains,
    rpc,
    legRpc,
    cfg,
    taker,
    maker,
    makerSenders,
    takerSenders,
    state: takerState,
    engine,
    advance: (seconds: number) => {
      state.now += seconds;
    },
    mine: (count = 2) => {
      for (let index = 0; index < count; index += 1) {
        chains.eth.snapshot();
        chains.qrl.snapshot();
      }
    },
    close: async () => {
      taker.close();
      maker.close();
      await book.close();
      await rpc.eth.close();
      await rpc.qrl.close();
    },
  };
}

/** Maker escrows its leg with the terms it signed into FillV2. */
async function makerLocks(h: Harness): Promise<void> {
  const fill = h.maker.fill;
  assert.notEqual(fill, null);
  if (fill === null) return;
  const iLeg: LegKey = h.maker.order?.order.direction === "eth->qrl" ? "eth" : "qrl";
  const recipient =
    iLeg === "eth" ? fill.fill.takerEthAccount : fill.fill.takerQrlAccount;
  const asset = h.maker.order?.order.asset ?? "ETH";
  const amount = BigInt(h.maker.order?.order.fromAmount ?? "0");
  const token = iLeg === "eth" ? assetInfo(asset).tokenAddress : null;
  if (token !== null) throw new Error("this harness escrows the maker leg natively");
  await h.makerSenders[iLeg].send(
    encodeLock(iLeg, fill.fill.hashlock, recipient, fill.fill.initiatorTimeout),
    amount,
  );
  h.mine();
}

/** Maker claims the taker escrow, which publishes the preimage. */
async function makerClaims(h: Harness): Promise<void> {
  const fill = h.maker.fill;
  if (fill === null) throw new Error("no fill");
  const rLeg: LegKey = h.maker.order?.order.direction === "eth->qrl" ? "qrl" : "eth";
  await h.makerSenders[rLeg].send(
    encodeClaim(rLeg, fill.fill.hashlock, h.maker.preimage),
    0n,
  );
  h.mine();
}

async function begin(h: Harness): Promise<TakerSwapRecord> {
  const orderId = h.maker.publishOrder();
  const quotes = await h.engine.list();
  assert.equal(quotes.quotes.length, 1);
  assert.equal(quotes.quotes[0]?.id, orderId);
  return h.engine.begin(orderId);
}

describe("scripted taker end to end", () => {
  it("swaps eth->qrl: propose, verify, fund, claim", async () => {
    const h = await harness({ direction: "eth->qrl" });
    try {
      let record = await begin(h);
      // 1. propose
      ({ record } = await h.engine.step(record));
      assert.equal(h.book.list(h.maker.orderId).length, 1);
      // 2. the maker publishes its terminal fill
      h.maker.selectAndFill();
      const afterFill = await h.engine.step(record);
      record = afterFill.record;
      assert.equal(record.fillAcknowledged, true);
      assert.equal(afterFill.verdict.decision, "wait");
      assert.equal(afterFill.verdict.makerLock.state, "absent");
      // 3. the maker escrows, the taker verifies at depth and funds
      await makerLocks(h);
      const funded = await h.engine.step(record);
      record = funded.record;
      assert.equal(funded.verdict.decision, "lock");
      assert.equal(
        h.chains.qrl.getSwap(h.maker.hashlock, "latest").status,
        SwapStatus.Open,
      );
      assert.equal(
        h.chains.qrl.getSwap(h.maker.hashlock, "latest").amount,
        BigInt(h.maker.order?.order.toAmount ?? "0"),
      );
      // 4. the maker claims and reveals; the taker claims its payout
      await makerClaims(h);
      const claimed = await h.engine.step(record);
      record = claimed.record;
      assert.equal(claimed.verdict.decision, "claim");
      assert.equal(
        h.chains.eth.getSwap(h.maker.hashlock, "latest").status,
        SwapStatus.Claimed,
      );
      // 5. settled, and the record is retired
      const done = await h.engine.step(record);
      assert.equal(done.verdict.decision, "finish");
      assert.equal(done.record.outcome, "claimed");
      assert.deepEqual(h.state.all(), []);
    } finally {
      await h.close();
    }
  });

  it("swaps qrl->eth on a token leg with an exact approval", async () => {
    const h = await harness({
      direction: "qrl->eth",
      asset: "USDC",
      fromAmount: (5n * 10n ** 18n).toString(),
      toAmount: (5n * 10n ** 6n).toString(),
    });
    try {
      let record = await begin(h);
      ({ record } = await h.engine.step(record));
      h.maker.selectAndFill();
      ({ record } = await h.engine.step(record));
      await makerLocks(h);
      const funded = await h.engine.step(record);
      record = funded.record;
      assert.equal(funded.verdict.decision, "lock");
      const token = assetInfo("USDC").tokenAddress ?? "";
      // One approval, sent to the token, and the escrow consumed all of it:
      // together that pins the approval to the exact escrow amount.
      const approvals = h.takerSenders.eth.sent.filter(
        (tx) => tx.to?.toLowerCase() === token.toLowerCase(),
      );
      assert.equal(approvals.length, 1);
      assert.equal(
        h.chains.eth.allowances.get(
          `${TAKER_ETH.toLowerCase()}:${h.cfg.ethHtlc.toLowerCase()}`,
        ),
        0n,
      );
      const escrow = h.chains.eth.getSwap(h.maker.hashlock, "latest");
      assert.equal(escrow.amount, 5n * 10n ** 6n);
      assert.equal(escrow.token.toLowerCase(), token.toLowerCase());
      await makerClaims(h);
      ({ record } = await h.engine.step(record));
      assert.equal(
        h.chains.qrl.getSwap(h.maker.hashlock, "latest").status,
        SwapStatus.Claimed,
      );
      const done = await h.engine.step(record);
      assert.equal(done.record.outcome, "claimed");
    } finally {
      await h.close();
    }
  });

  it("treats an escrow already claimed by a sponsoring maker as success", async () => {
    // The sender claims the maker leg for us right before our own claim
    // lands, exactly as a maker sponsoring taker gas would.
    let sponsor: (() => void) | null = null;
    const h = await harness({
      direction: "eth->qrl",
      takerSenderFactory: (leg, chain, address) => {
        if (leg !== "eth") return new FakeLegSender(address, chain);
        const sender = new FakeLegSender(address, chain);
        const original = sender.send.bind(sender);
        sender.send = async (data: string, value: bigint, to?: string) => {
          sponsor?.();
          return original(data, value, to);
        };
        return sender;
      },
    });
    try {
      let record = await begin(h);
      ({ record } = await h.engine.step(record));
      h.maker.selectAndFill();
      ({ record } = await h.engine.step(record));
      await makerLocks(h);
      ({ record } = await h.engine.step(record));
      await makerClaims(h);
      sponsor = () => {
        h.chains.eth.claim(h.maker.hashlock, h.maker.preimage);
      };
      const raced = await h.engine.step(record);
      record = raced.record;
      assert.equal(raced.verdict.decision, "claim");
      assert.equal(
        h.chains.eth.getSwap(h.maker.hashlock, "latest").status,
        SwapStatus.Claimed,
      );
      sponsor = null;
      const done = await h.engine.step(record);
      assert.equal(done.verdict.decision, "finish");
      assert.equal(done.record.outcome, "claimed");
    } finally {
      await h.close();
    }
  });

  it("refuses to fund a maker escrow with the wrong amount", async () => {
    const h = await harness({ direction: "eth->qrl" });
    try {
      let record = await begin(h);
      ({ record } = await h.engine.step(record));
      const fill = h.maker.selectAndFill();
      ({ record } = await h.engine.step(record));
      // The maker escrows one base unit short of the signed terms.
      await h.makerSenders.eth.send(
        encodeLock(
          "eth",
          fill.fill.hashlock,
          fill.fill.takerEthAccount,
          fill.fill.initiatorTimeout,
        ),
        BigInt(h.maker.order?.order.fromAmount ?? "0") - 1n,
      );
      h.mine();
      const refused = await h.engine.step(record);
      assert.equal(refused.verdict.decision, "abort");
      assert.match(refused.verdict.reason, /refusing to fund/);
      assert.equal(
        h.chains.qrl.getSwap(fill.fill.hashlock, "latest").status,
        SwapStatus.None,
      );
      assert.deepEqual(h.state.all(), []);
    } finally {
      await h.close();
    }
  });

  it("waits for confirmation depth before funding", async () => {
    const h = await harness({ direction: "eth->qrl" });
    try {
      let record = await begin(h);
      ({ record } = await h.engine.step(record));
      h.maker.selectAndFill();
      ({ record } = await h.engine.step(record));
      const fill = h.maker.fill;
      assert.notEqual(fill, null);
      if (fill === null) return;
      // Escrow it without mining past the confirmation depth.
      await h.makerSenders.eth.send(
        encodeLock(
          "eth",
          fill.fill.hashlock,
          fill.fill.takerEthAccount,
          fill.fill.initiatorTimeout,
        ),
        BigInt(h.maker.order?.order.fromAmount ?? "0"),
      );
      const waited = await h.engine.step(record);
      assert.equal(waited.verdict.decision, "wait");
      assert.equal(
        h.chains.qrl.getSwap(fill.fill.hashlock, "latest").status,
        SwapStatus.None,
      );
    } finally {
      await h.close();
    }
  });

  it("refunds our escrow when the maker never claims", async () => {
    const h = await harness({ direction: "eth->qrl" });
    try {
      let record = await begin(h);
      ({ record } = await h.engine.step(record));
      h.maker.selectAndFill();
      ({ record } = await h.engine.step(record));
      await makerLocks(h);
      ({ record } = await h.engine.step(record));
      const fill = h.maker.fill;
      if (fill === null) throw new Error("no fill");
      h.advance(fill.fill.responderTimeout - h.now + 1);
      const refunded = await h.engine.step(record);
      record = refunded.record;
      assert.equal(refunded.verdict.decision, "refund");
      assert.equal(
        h.chains.qrl.getSwap(fill.fill.hashlock, "latest").status,
        SwapStatus.Refunded,
      );
      // The maker's own escrow refunds at its later deadline.
      h.advance(fill.fill.initiatorTimeout - h.now + 1);
      await h.makerSenders.eth.send(
        encodeRefund("eth", fill.fill.hashlock),
        0n,
      );
      h.mine();
      const done = await h.engine.step(record);
      assert.equal(done.verdict.decision, "finish");
      assert.equal(done.record.outcome, "refunded");
    } finally {
      await h.close();
    }
  });

  it("gives up when the maker fills another taker's proposal", async () => {
    const h = await harness({ direction: "eth->qrl" });
    try {
      let record = await begin(h);
      ({ record } = await h.engine.step(record));
      // A second taker proposes and the maker picks that one.
      const rival = new ProtocolSigner(`0x010000${"0b".repeat(48)}`);
      try {
        const order = h.maker.order;
        if (order === null) throw new Error("no order");
        const signed = rival.signFillIntentV1({
          order,
          orderDigest: record.orderDigest,
          takerEthAccount: `0x${"e".repeat(40)}`,
          releaseSecret: `0x${"77".repeat(32)}`,
          issuedAt: h.now,
        });
        await new TakerBookClient(h.cfg.orderbookUrl, 5_000).submitIntent(
          h.maker.orderId,
          signed,
        );
        // Drop our proposal so the maker's first-come pick is the rival's.
        const intents = h.book.list(h.maker.orderId);
        intents.splice(0, 1);
        h.maker.selectAndFill();
      } finally {
        rival.close();
      }
      const verdict = await h.engine.step(record);
      assert.equal(verdict.verdict.decision, "abort");
      assert.deepEqual(h.state.all(), []);
    } finally {
      await h.close();
    }
  });

  it("gives up when the maker cancels before filling", async () => {
    const h = await harness({ direction: "eth->qrl" });
    try {
      let record = await begin(h);
      ({ record } = await h.engine.step(record));
      h.book.cancel(h.maker.orderId);
      const verdict = await h.engine.step(record);
      assert.equal(verdict.verdict.decision, "abort");
      assert.deepEqual(h.state.all(), []);
    } finally {
      await h.close();
    }
  });

  it("gives up when the order leaves the book before funding", async () => {
    const h = await harness({ direction: "eth->qrl" });
    try {
      let record = await begin(h);
      ({ record } = await h.engine.step(record));
      h.book.drop(h.maker.orderId);
      const verdict = await h.engine.step(record);
      assert.equal(verdict.verdict.decision, "abort");
    } finally {
      await h.close();
    }
  });

  it("stops funding once a release was observed", async () => {
    const h = await harness({ direction: "eth->qrl" });
    try {
      let record = await begin(h);
      ({ record } = await h.engine.step(record));
      h.maker.selectAndFill();
      ({ record } = await h.engine.step(record));
      await makerLocks(h);
      h.book.markReleased(h.maker.orderId);
      const verdict = await h.engine.step(record);
      record = verdict.record;
      assert.equal(record.releaseObserved, true);
      assert.notEqual(verdict.verdict.decision, "lock");
      assert.equal(
        h.chains.qrl.getSwap(h.maker.hashlock, "latest").status,
        SwapStatus.None,
      );
    } finally {
      await h.close();
    }
  });

  it("walks away by revealing the committed release secret", async () => {
    const h = await harness({ direction: "eth->qrl" });
    try {
      let record = await begin(h);
      ({ record } = await h.engine.step(record));
      const released = await h.engine.step(record, { abandon: true });
      assert.equal(released.verdict.decision, "release");
      assert.equal(released.record.outcome, "released");
      assert.deepEqual(h.state.all(), []);
    } finally {
      await h.close();
    }
  });

  it("waits out a book that already holds one of our proposals", async () => {
    const h = await harness({ direction: "eth->qrl" });
    try {
      let record = await begin(h);
      h.book.conflictOnIntent = true;
      const verdict = await h.engine.step(record);
      record = verdict.record;
      assert.equal(verdict.verdict.decision, "propose");
      // The proposal, its secret and its submission marker were persisted
      // before the send, so the next pass waits the slot out.
      assert.equal(record.intents.length, 1);
      assert.notEqual(record.intents[0]?.submittedAt, null);
      assert.equal(h.state.get(record.orderId)?.intents.length, 1);
      const again = await h.engine.step(record);
      assert.equal(again.verdict.decision, "wait");
      assert.equal(again.record.intents.length, 1);
      assert.equal(
        again.record.intents[0]?.releaseSecret,
        record.intents[0]?.releaseSecret,
      );
    } finally {
      await h.close();
    }
  });

  it("resumes an in-flight take from the state file alone", async () => {
    const h = await harness({ direction: "eth->qrl" });
    try {
      let record = await begin(h);
      ({ record } = await h.engine.step(record));
      h.maker.selectAndFill();
      ({ record } = await h.engine.step(record));
      await makerLocks(h);
      ({ record } = await h.engine.step(record));
      // A fresh process reads the same file and continues from there.
      const reopened = new TakerStateFile(h.cfg.stateFile, DEPLOYMENT);
      const recovered = reopened.all();
      assert.equal(recovered.length, 1);
      const resumed = new TakerEngine({
        cfg: h.cfg,
        book: new TakerBookClient(h.cfg.orderbookUrl, 5_000),
        legRpc: h.legRpc,
        signing: {
          signer: h.taker,
          eth: h.takerSenders.eth,
          qrl: h.takerSenders.qrl,
          state: reopened,
          deployment: DEPLOYMENT,
        },
        now: h.clock,
        log: () => undefined,
        sleep: async () => undefined,
      });
      await makerClaims(h);
      const verdicts = await resumed.resume({ maxPasses: 1 });
      assert.equal(verdicts.length, 1);
      assert.equal(verdicts[0]?.decision, "claim");
      assert.equal(
        h.chains.eth.getSwap(h.maker.hashlock, "latest").status,
        SwapStatus.Claimed,
      );
    } finally {
      await h.close();
    }
  });

  it("never funds twice when the same step runs again", async () => {
    const h = await harness({ direction: "eth->qrl" });
    try {
      let record = await begin(h);
      ({ record } = await h.engine.step(record));
      h.maker.selectAndFill();
      ({ record } = await h.engine.step(record));
      await makerLocks(h);
      ({ record } = await h.engine.step(record));
      const sent = h.takerSenders.qrl.sent.length;
      const again = await h.engine.step(record);
      assert.equal(again.verdict.decision, "wait");
      assert.equal(h.takerSenders.qrl.sent.length, sent);
    } finally {
      await h.close();
    }
  });

  it("sends and persists nothing in a dry run", async () => {
    const h = await harness({ direction: "eth->qrl", dryRun: true });
    try {
      const orderId = h.maker.publishOrder();
      const record = await h.engine.begin(orderId);
      const verdict = await h.engine.step(record);
      assert.equal(verdict.verdict.decision, "propose");
      assert.deepEqual(h.state.all(), []);
      assert.equal(h.book.list(orderId).length, 0);
      assert.equal(h.takerSenders.qrl.sent.length, 0);
    } finally {
      await h.close();
    }
  });

  it("quotes an order without keys or state", async () => {
    const h = await harness({ direction: "eth->qrl" });
    try {
      const orderId = h.maker.publishOrder();
      const readOnly = new TakerEngine({
        cfg: h.cfg,
        book: new TakerBookClient(h.cfg.orderbookUrl, 5_000),
        legRpc: h.legRpc,
        now: h.clock,
        log: () => undefined,
      });
      const quote = await readOnly.quote(orderId);
      assert.equal(quote.id, orderId);
      assert.equal(quote.pay.symbol, "QRL");
      assert.equal(quote.receive.symbol, "ETH");
      assert.equal(quote.issue, null);
      await assert.rejects(
        readOnly.begin(orderId),
        /needs taker keys/,
      );
    } finally {
      await h.close();
    }
  });

  it("refuses a take above the --max-in limit", async () => {
    const h = await harness({ direction: "eth->qrl" });
    try {
      const orderId = h.maker.publishOrder();
      await assert.rejects(
        h.engine.begin(orderId, { maxIn: 10n }),
        /max-in/,
      );
      assert.deepEqual(h.state.all(), []);
    } finally {
      await h.close();
    }
  });

  it("refuses an order whose proof expires too soon to swap", async () => {
    const h = await harness({ direction: "eth->qrl" });
    try {
      const orderId = h.maker.publishOrder(600);
      await assert.rejects(h.engine.begin(orderId), /expires too soon/);
    } finally {
      await h.close();
    }
  });
});
