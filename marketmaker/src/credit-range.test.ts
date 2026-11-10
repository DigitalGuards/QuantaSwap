// Credit attribution on endpoints that cap the log range. The fake chain
// refuses any query wider than its cap, with the two error shapes seen on
// the public Sepolia endpoints, so the walk is tested against the refusal
// itself.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  CREDIT_LOOKBACK_MARGIN_S,
  NATIVE_TOKEN,
  QRL_NATIVE_TOKEN,
  getCreditedForSwap,
  readSwapCredit,
  type LegKey,
  type LegRpc,
} from "./htlc.js";
import { protocolV2Config } from "./protocol-v2-config.js";
import { creditScanSinceS } from "./taker.js";
import {
  FakeHtlcChain,
  sha256Hex,
  startFakeChainRpc,
  type FakeEndpoint,
} from "./taker-test-harness.js";

const PAYEE: Record<LegKey, string> = {
  eth: `0x${"c".repeat(40)}`,
  qrl: `Q${"d".repeat(128)}`,
};
const CAP = 1_000;
const T0 = 1_700_000_000;
const BLOCK_TIME_S = 12;

const preimageFor = (n: number): string =>
  `0x${n.toString(16).padStart(64, "0")}`;

interface Fixture {
  chain: FakeHtlcChain;
  leg: LegRpc;
  endpoint: FakeEndpoint;
}

async function fixture(
  ns: LegKey,
  options: { cap: number | null; chunk: number },
): Promise<Fixture> {
  const htlc =
    ns === "eth" ? protocolV2Config.ethHtlc : protocolV2Config.qrlHtlc;
  // One block every 12 seconds of the fake clock.
  const minted: { chain?: FakeHtlcChain } = {};
  const chain = new FakeHtlcChain(
    ns,
    htlc,
    () => T0 + (minted.chain?.height ?? 0) * BLOCK_TIME_S,
  );
  minted.chain = chain;
  chain.maxLogRange = options.cap;
  const endpoint = await startFakeChainRpc(chain);
  const leg: LegRpc = {
    url: endpoint.url,
    ns,
    htlc,
    timeoutMs: 5_000,
    logChunkBlocks: options.chunk,
  };
  return { chain, leg, endpoint };
}

/** A swap whose payout cannot be delivered, so its claim credits the payee. */
function creditedSwap(chain: FakeHtlcChain, n: number, amount: bigint): string {
  const payee = PAYEE[chain.leg];
  const preimage = preimageFor(n);
  const hashlock = sha256Hex(preimage);
  chain.rejectDeliveryTo(payee);
  chain.lock({
    from: payee,
    hashlock,
    recipient: payee,
    amount,
    timeout: T0 + 10_000_000,
  });
  chain.claim(hashlock, preimage);
  return hashlock;
}

const tokenFor = (ns: LegKey): string =>
  ns === "eth" ? NATIVE_TOKEN : QRL_NATIVE_TOKEN;

const REFUSALS = [
  { code: -32701, message: "exceed maximum block range: 50000" },
  { code: -32000, message: "getLogs request exceeded max allowed range" },
];

void describe("credit attribution under a log range cap", () => {
  for (const refusal of REFUSALS) {
    void it(`finds a credit on an endpoint that refuses wide ranges (${refusal.message})`, async () => {
      const f = await fixture("eth", { cap: CAP, chunk: CAP });
      try {
        f.chain.logRangeError = refusal;
        const hashlock = creditedSwap(f.chain, 1, 7n);
        f.chain.advance(4_500);
        // The old query shape: one range from block 0 to the head.
        const wide = await fetch(f.leg.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "eth_getLogs",
            params: [{ fromBlock: "0x0", toBlock: "latest" }],
          }),
        });
        const body: unknown = await wide.json();
        assert.deepEqual(body, {
          jsonrpc: "2.0",
          id: 1,
          error: refusal,
        });
        assert.equal(
          await getCreditedForSwap(f.leg, NATIVE_TOKEN, PAYEE.eth, hashlock),
          7n,
        );
        for (const q of f.chain.logQueries.slice(1)) {
          assert.ok(q.to - q.from + 1 <= CAP);
        }
      } finally {
        await f.endpoint.close();
      }
    });
  }

  void it("a chunk wider than the endpoint cap fails the read", async () => {
    const f = await fixture("eth", { cap: CAP, chunk: 10 * CAP });
    try {
      const hashlock = creditedSwap(f.chain, 1, 7n);
      f.chain.advance(4_500);
      await assert.rejects(
        getCreditedForSwap(f.leg, NATIVE_TOKEN, PAYEE.eth, hashlock),
      );
    } finally {
      await f.endpoint.close();
    }
  });

  void it("finds a credit in the first chunk, in the last chunk, and sums none as zero", async () => {
    const f = await fixture("eth", { cap: CAP, chunk: CAP });
    try {
      const early = creditedSwap(f.chain, 1, 5n);
      f.chain.advance(3_500);
      const late = creditedSwap(f.chain, 2, 9n);
      const none = sha256Hex(preimageFor(3));
      const read = (hashlock: string): Promise<bigint> =>
        getCreditedForSwap(f.leg, NATIVE_TOKEN, PAYEE.eth, hashlock);
      assert.equal(await read(early), 5n);
      assert.equal(await read(late), 9n);
      f.chain.logQueries.length = 0;
      assert.equal(await read(none), 0n);
      // Zero is only reported after every chunk up to the head answered.
      const covered = f.chain.logQueries;
      assert.equal(covered[0]?.from, 0);
      assert.equal(covered[covered.length - 1]?.to, f.chain.height);
      for (let i = 1; i < covered.length; i += 1) {
        assert.equal(covered[i]?.from, (covered[i - 1]?.to ?? 0) + 1);
      }
    } finally {
      await f.endpoint.close();
    }
  });

  void it("a failing middle chunk fails the whole read, never a partial sum", async () => {
    const f = await fixture("eth", { cap: CAP, chunk: CAP });
    try {
      const early = creditedSwap(f.chain, 1, 5n);
      f.chain.advance(4_500);
      f.chain.failLogsAtBlock = 2_500;
      await assert.rejects(
        getCreditedForSwap(f.leg, NATIVE_TOKEN, PAYEE.eth, early),
      );
      await assert.rejects(
        readSwapCredit(f.leg, NATIVE_TOKEN, PAYEE.eth, early),
      );
    } finally {
      await f.endpoint.close();
    }
  });

  void it("starts at the block of the caller's bound and still finds an old swap", async () => {
    const f = await fixture("eth", { cap: CAP, chunk: CAP });
    try {
      f.chain.advance(12_000);
      const hashlock = creditedSwap(f.chain, 1, 11n);
      const creditBlock = f.chain.height;
      f.chain.advance(3_000);
      // The swap was created 100 blocks before its credit.
      const createdS = f.chain.blockTimestamp(creditBlock - 100);
      f.chain.logQueries.length = 0;
      assert.equal(
        await getCreditedForSwap(
          f.leg,
          NATIVE_TOKEN,
          PAYEE.eth,
          hashlock,
          createdS,
        ),
        11n,
      );
      const first = f.chain.logQueries[0];
      assert.ok(first !== undefined);
      // The scan starts above genesis and at or before the creation block.
      assert.ok(first.from > 0);
      const slackBlocks = Math.ceil(CREDIT_LOOKBACK_MARGIN_S / BLOCK_TIME_S);
      assert.ok(first.from <= creditBlock - 100);
      assert.ok(first.from >= creditBlock - 100 - slackBlocks - 1);
      // A bound newer than the head reads only the head block.
      f.chain.logQueries.length = 0;
      assert.equal(
        await getCreditedForSwap(
          f.leg,
          NATIVE_TOKEN,
          PAYEE.eth,
          hashlock,
          f.chain.blockTimestamp(f.chain.height) +
            10 * CREDIT_LOOKBACK_MARGIN_S,
        ),
        0n,
      );
    } finally {
      await f.endpoint.close();
    }
  });

  void it("walks the QRL leg to the same answer as one wide query", async () => {
    const capped = await fixture("qrl", { cap: CAP, chunk: CAP });
    const wide = await fixture("qrl", { cap: null, chunk: 1_000_000 });
    try {
      const results: bigint[] = [];
      for (const f of [capped, wide]) {
        const hashlock = creditedSwap(f.chain, 1, 13n);
        f.chain.advance(3_200);
        results.push(
          await getCreditedForSwap(f.leg, tokenFor("qrl"), PAYEE.qrl, hashlock),
        );
      }
      assert.deepEqual(results, [13n, 13n]);
      assert.equal(wide.chain.logQueries.length, 1);
      assert.ok(capped.chain.logQueries.length > 1);
    } finally {
      await capped.endpoint.close();
      await wide.endpoint.close();
    }
  });

  void it("reads the ledger and the attribution together through readSwapCredit", async () => {
    const f = await fixture("eth", { cap: CAP, chunk: CAP });
    try {
      const hashlock = creditedSwap(f.chain, 1, 21n);
      f.chain.advance(2_500);
      const reading = await readSwapCredit(
        f.leg,
        NATIVE_TOKEN,
        PAYEE.eth,
        hashlock,
      );
      assert.deepEqual(reading, { global: 21n, credited: 21n });
    } finally {
      await f.endpoint.close();
    }
  });
});

void describe("taker credit scan bound", () => {
  void it("uses the order's signing time when it precedes the take", () => {
    assert.equal(
      creditScanSinceS({
        orderAuth: { issuedAt: T0 },
        createdAt: T0 + 40,
      }),
      T0,
    );
  });

  void it("falls back to the take's own start for a future-dated order proof", () => {
    assert.equal(
      creditScanSinceS({
        orderAuth: { issuedAt: T0 + 7 * 86_400 },
        createdAt: T0 + 40,
      }),
      T0 + 40,
    );
  });
});
