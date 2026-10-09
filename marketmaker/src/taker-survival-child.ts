// Test-only child process. It drives a complete swap with the engine's
// DEFAULT sleep and with every fake endpoint unref'd, so the only thing
// that can keep this process alive is the engine's own timer. A taker that
// exits mid-swap prints nothing and settles nothing, which is exactly the
// live failure this reproduces.
//
// Run by taker-survival.test.ts; never part of the daemon.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeDeploymentIdentity } from "./deployment.js";
import { encodeLock, SwapStatus, type LegKey, type LegRpc } from "./htlc.js";
import { protocolV2Config } from "./protocol-v2-config.js";
import { ProtocolSigner } from "./protocol-signing.js";
import { V2_TEST_EXTENDED_SEED } from "./protocol-v2-test-helper.js";
import type { TakerReadConfig } from "./taker-config.js";
import { TakerBookClient } from "./taker-orderbook.js";
import { TakerEngine } from "./taker.js";
import { TakerStateFile } from "./taker-state.js";
import {
  FakeBookServer,
  FakeHtlcChain,
  FakeLegSender,
  ScriptedMaker,
  startFakeChainRpc,
} from "./taker-test-harness.js";

const TAKER_SEED = `0x010000${"09".repeat(48)}`;
const MAKER_ETH = `0x${"a".repeat(40)}`;
const TAKER_ETH = `0x${"c".repeat(40)}`;

async function main(): Promise<void> {
  const clock = (): number => Math.floor(Date.now() / 1000);
  const book = new FakeBookServer(clock);
  await book.start();
  const chains: Record<LegKey, FakeHtlcChain> = {
    eth: new FakeHtlcChain("eth", protocolV2Config.ethHtlc, clock),
    qrl: new FakeHtlcChain("qrl", protocolV2Config.qrlHtlc, clock),
  };
  const rpc = {
    eth: await startFakeChainRpc(chains.eth),
    qrl: await startFakeChainRpc(chains.qrl),
  };
  // From here nothing but the engine's own timer holds the event loop.
  book.unref();
  rpc.eth.unref();
  rpc.qrl.unref();

  const taker = new ProtocolSigner(TAKER_SEED);
  const maker = new ScriptedMaker(
    V2_TEST_EXTENDED_SEED,
    book,
    {
      direction: "eth->qrl",
      asset: "ETH",
      fromAmount: (10n ** 15n).toString(),
      toAmount: (2n * 10n ** 18n).toString(),
      makerEthAccount: MAKER_ETH,
    },
    clock,
  );
  const legRpc: Record<LegKey, LegRpc> = {
    eth: {
      url: rpc.eth.url,
      ns: "eth",
      htlc: protocolV2Config.ethHtlc,
      timeoutMs: 5_000,
    },
    qrl: {
      url: rpc.qrl.url,
      ns: "qrl",
      htlc: protocolV2Config.qrlHtlc,
      timeoutMs: 5_000,
    },
  };
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
    pollMs: 50,
    resendAfterS: 240,
    claimSafetyS: 1_800,
    lockRunwayS: 900,
    minOrderRunwayS: 90,
    ethGasReserveWei: 10n ** 12n,
    qrlGasReserveWei: 10n ** 12n,
    stateFile: join(
      mkdtempSync(join(tmpdir(), "quantaswap-taker-survival-")),
      "state.json",
    ),
  };
  const deployment = makeDeploymentIdentity(cfg);
  const takerSenders: Record<LegKey, FakeLegSender> = {
    eth: new FakeLegSender(TAKER_ETH, chains.eth),
    qrl: new FakeLegSender(taker.address, chains.qrl),
  };
  const makerSenders: Record<LegKey, FakeLegSender> = {
    eth: new FakeLegSender(MAKER_ETH, chains.eth),
    qrl: new FakeLegSender(maker.qrlAccount, chains.qrl),
  };

  let passes = 0;
  /** The counterparty, driven from the clock seam so no extra timer exists.
   *  Idempotent: each call performs at most the one action that is due. */
  const driveMaker = (): void => {
    const order = maker.order;
    if (order === null) return;
    if (maker.fill === null) {
      if (book.list(maker.orderId).length > 0) maker.selectAndFill();
      return;
    }
    const fill = maker.fill;
    if (
      chains.eth.getSwap(fill.fill.hashlock, "latest").status ===
      SwapStatus.None
    ) {
      void makerSenders.eth.send(
        encodeLock(
          "eth",
          fill.fill.hashlock,
          fill.fill.takerEthAccount,
          fill.fill.initiatorTimeout,
        ),
        BigInt(order.order.fromAmount),
      );
      chains.eth.snapshot();
      chains.eth.snapshot();
      return;
    }
    const ours = chains.qrl.getSwap(fill.fill.hashlock, "latest");
    if (ours.status === SwapStatus.Open) {
      chains.qrl.claim(fill.fill.hashlock, maker.preimage);
      chains.qrl.snapshot();
    }
  };

  const engine = new TakerEngine({
    cfg,
    book: new TakerBookClient(cfg.orderbookUrl, cfg.netTimeoutMs),
    legRpc,
    signing: {
      signer: taker,
      eth: takerSenders.eth,
      qrl: takerSenders.qrl,
      state: new TakerStateFile(cfg.stateFile, deployment),
      deployment,
    },
    now: () => {
      driveMaker();
      return clock();
    },
    log: (...args: unknown[]) => {
      console.log("[child]", ...args);
    },
    // The sleep is deliberately left at its default.
  });

  const orderId = maker.publishOrder();
  const record = await engine.begin(orderId);
  const result = await engine.run(record, {
    abandon: () => {
      passes += 1;
      return false;
    },
  });
  console.log(`PASSES:${passes}`);
  console.log(`SETTLED:${result.outcome ?? "none"}`);
  console.log(
    `CLAIMED:${
      chains.eth.getSwap(maker.hashlock, "latest").status === SwapStatus.Claimed
    }`,
  );
  taker.close();
  maker.close();
}

main().catch((error: unknown) => {
  console.error(
    "CHILD_FAILED:",
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
});
