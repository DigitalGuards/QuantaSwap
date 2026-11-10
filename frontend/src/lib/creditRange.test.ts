// Credit attribution on endpoints that cap the log range. The fake RPC
// refuses any query wider than its cap with the two error shapes seen on the
// public Sepolia endpoints, so the walk is tested against the refusal itself.

import { afterEach, describe, expect, it, vi } from "vitest";
import { isArray, isRecord } from "@/utils/guards";
import {
  CREDIT_LOG_CHUNK_BLOCKS,
  CREDIT_LOOKBACK_MARGIN_S,
  NATIVE_TOKEN,
  getCreditedForSwap,
  htlcInterface,
  readSwapCredit,
} from "./htlc";

afterEach(() => vi.unstubAllGlobals());

const HASHLOCK = `0x${"12".repeat(32)}`;
const OTHER_HASHLOCK = `0x${"34".repeat(32)}`;
const ACCOUNT = `0x${"b".repeat(40)}`;
const T0 = 1_700_000_000;
const BLOCK_TIME_S = 12;
const CAP = CREDIT_LOG_CHUNK_BLOCKS;

const REFUSALS = [
  "exceed maximum block range: 50000",
  "getLogs request exceeded max allowed range",
] as const;

interface Chain {
  head: number;
  /** hashlock -> [block, amount] */
  credits: [string, number, bigint][];
  refusal: string;
  failAtBlock: number | null;
  queries: { from: number; to: number }[];
}

const word = (value: bigint): string => `0x${value.toString(16).padStart(64, "0")}`;

interface Filter {
  fromBlock: string;
  toBlock: string;
  topics: string[];
}

const isFilter = (value: unknown): value is Filter =>
  isRecord(value) &&
  typeof value.fromBlock === "string" &&
  typeof value.toBlock === "string" &&
  isArray(value.topics);

function stubChain(chain: Chain): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: unknown, init: RequestInit) => {
      const request: unknown = JSON.parse(typeof init.body === "string" ? init.body : "null");
      if (!isRecord(request) || typeof request.method !== "string" || !isArray(request.params)) {
        throw new Error("malformed test request");
      }
      const { method, params } = request;
      const reply = (result: unknown) =>
        Promise.resolve({ ok: true, json: () => Promise.resolve({ result }) });
      const refuse = (message: string) =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ error: { code: -32000, message } }),
        });
      switch (method) {
        case "eth_blockNumber":
          return reply(`0x${chain.head.toString(16)}`);
        case "eth_getBlockByNumber": {
          const block = Number(BigInt(typeof params[0] === "string" ? params[0] : "0x0"));
          return reply({ timestamp: `0x${(T0 + block * BLOCK_TIME_S).toString(16)}` });
        }
        case "eth_call":
          return reply(
            htlcInterface.encodeFunctionResult("creditOf", [
              chain.credits.reduce((sum, entry) => sum + entry[2], 0n),
            ]),
          );
        case "eth_getLogs": {
          const filter = params[0];
          if (!isFilter(filter)) throw new Error("malformed log filter");
          const from = Number(BigInt(filter.fromBlock));
          const to = Number(BigInt(filter.toBlock));
          chain.queries.push({ from, to });
          if (to - from + 1 > CAP) return refuse(chain.refusal);
          if (chain.failAtBlock !== null && from <= chain.failAtBlock && chain.failAtBlock <= to) {
            return refuse("upstream unavailable");
          }
          return reply(
            chain.credits
              .filter(
                ([hashlock, block]) =>
                  hashlock === filter.topics[3] && block >= from && block <= to,
              )
              .map(([, , amount]) => ({ data: word(amount) })),
          );
        }
        default:
          return refuse(`unsupported ${method}`);
      }
    }),
  );
}

const chainWith = (overrides: Partial<Chain> = {}): Chain => ({
  head: 30_000,
  credits: [],
  refusal: REFUSALS[0],
  failAtBlock: null,
  queries: [],
  ...overrides,
});

const read = (hashlock = HASHLOCK, notBeforeS?: number) =>
  getCreditedForSwap("eth", NATIVE_TOKEN, ACCOUNT, hashlock, notBeforeS);

describe("credit attribution under a log range cap", () => {
  it.each(REFUSALS)(
    "finds a credit on an endpoint that refuses wide ranges (%s)",
    async (refusal) => {
      const chain = chainWith({ refusal, credits: [[HASHLOCK, 12_345, 7n]] });
      stubChain(chain);
      await expect(read()).resolves.toBe(7n);
      expect(chain.queries.every((q) => q.to - q.from + 1 <= CAP)).toBe(true);
    },
  );

  it("finds a credit in the first chunk and in the last chunk", async () => {
    const chain = chainWith({
      credits: [
        [HASHLOCK, 3, 5n],
        [OTHER_HASHLOCK, 30_000, 9n],
      ],
    });
    stubChain(chain);
    await expect(read(HASHLOCK)).resolves.toBe(5n);
    await expect(read(OTHER_HASHLOCK)).resolves.toBe(9n);
  });

  it("reports zero only after every chunk to the head answered", async () => {
    const chain = chainWith();
    stubChain(chain);
    await expect(read()).resolves.toBe(0n);
    expect(chain.queries[0]?.from).toBe(0);
    expect(chain.queries.at(-1)?.to).toBe(chain.head);
    chain.queries.slice(1).forEach((q, i) => {
      expect(q.from).toBe((chain.queries[i]?.to ?? 0) + 1);
    });
  });

  it("fails the whole read when one chunk fails, so the credit stays unknown", async () => {
    const chain = chainWith({ credits: [[HASHLOCK, 3, 5n]], failAtBlock: 17_000 });
    stubChain(chain);
    await expect(read()).rejects.toThrow();
    await expect(readSwapCredit("eth", NATIVE_TOKEN, ACCOUNT, HASHLOCK)).rejects.toThrow();
  });

  it("starts at the block of the caller's bound, with a day of slack", async () => {
    const creditBlock = 20_000;
    const chain = chainWith({ credits: [[HASHLOCK, creditBlock, 11n]] });
    stubChain(chain);
    const beganS = T0 + (creditBlock - 100) * BLOCK_TIME_S;
    await expect(read(HASHLOCK, beganS)).resolves.toBe(11n);
    const first = chain.queries[0];
    expect(first?.from).toBeGreaterThan(0);
    const slackBlocks = CREDIT_LOOKBACK_MARGIN_S / BLOCK_TIME_S;
    expect(first?.from).toBeLessThanOrEqual(creditBlock - 100);
    expect(first?.from).toBeGreaterThanOrEqual(creditBlock - 100 - slackBlocks - 1);
  });

  it("reads only the head block for a bound newer than the head", async () => {
    const chain = chainWith({ credits: [[HASHLOCK, 3, 5n]] });
    stubChain(chain);
    const future = T0 + chain.head * BLOCK_TIME_S + 10 * CREDIT_LOOKBACK_MARGIN_S;
    await expect(read(HASHLOCK, future)).resolves.toBe(0n);
    expect(chain.queries).toEqual([{ from: chain.head, to: chain.head }]);
  });

  it("returns both halves through readSwapCredit", async () => {
    stubChain(chainWith({ credits: [[HASHLOCK, 12_345, 21n]] }));
    await expect(readSwapCredit("eth", NATIVE_TOKEN, ACCOUNT, HASHLOCK)).resolves.toEqual({
      global: 21n,
      credited: 21n,
    });
  });
});
