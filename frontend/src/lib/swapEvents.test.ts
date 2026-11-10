// The explorer-link lookup on endpoints that enforce the real limits: the
// ETH logs endpoint refuses wide ranges, and the QRL proxy refuses a scan
// from genesis, a range over 5,000 blocks and a non-numeric bound.

import { afterEach, describe, expect, it, vi } from "vitest";
import { isArray, isRecord } from "@/utils/guards";
import { PRELOCK_INITIATOR_TIMEOUT_S, QRL_LEG } from "../config";
import {
  CREDIT_LOG_CHUNK_BLOCKS,
  SwapStatus,
  getSwapEvents,
  type LegState,
  htlcInterface,
  qrvm64Topic,
  swapEventsNotBeforeS,
} from "./htlc";

vi.mock("../config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config")>();
  return { ...actual, QRL_LEG: { ...actual.QRL_LEG, htlc: `Q${"ab".repeat(64)}` } };
});
afterEach(() => vi.unstubAllGlobals());

const HASHLOCK = `0x${"12".repeat(32)}`;
const T0 = 1_700_000_000;
const BLOCK_TIME_S = 12;
const HEAD = 40_000;
const LOCK_BLOCK = 30_000;
const TIMEOUT_S = T0 + LOCK_BLOCK * BLOCK_TIME_S + 7_200;
const NOT_BEFORE_S = TIMEOUT_S - PRELOCK_INITIATOR_TIMEOUT_S;
const topicOf = (name: string): string => htlcInterface.getEvent(name)?.topicHash ?? "";

interface FakeLog {
  leg: "eth" | "qrl";
  block: number;
  kind: "Locked" | "Claimed";
  txHash: string;
}

interface Fake {
  logs: FakeLog[];
  queries: { leg: "eth" | "qrl"; from: number; to: number; topics: unknown[] }[];
  requests: string[];
  failAtBlock: number | null;
}

const newFake = (logs: FakeLog[] = []): Fake => ({
  logs,
  queries: [],
  requests: [],
  failAtBlock: null,
});

function stub(fake: Fake): void {
  const body = (result: unknown) => ({ ok: true, json: () => Promise.resolve({ result }) });
  const refuse = (message: string) => ({
    ok: true,
    json: () => Promise.resolve({ error: { code: -32000, message } }),
  });
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: unknown, init: RequestInit) => {
      const request: unknown = JSON.parse(typeof init.body === "string" ? init.body : "null");
      if (!isRecord(request) || typeof request.method !== "string" || !isArray(request.params)) {
        throw new Error("malformed test request");
      }
      const { method, params } = request;
      fake.requests.push(method);
      const leg = method.startsWith("qrl_") ? "qrl" : "eth";
      switch (method) {
        case "qrl_chainId":
          return Promise.resolve(body(QRL_LEG.chainIdHex));
        case "eth_blockNumber":
        case "qrl_blockNumber":
          return Promise.resolve(body(`0x${HEAD.toString(16)}`));
        case "eth_getBlockByNumber":
        case "qrl_getBlockByNumber": {
          const tag = typeof params[0] === "string" ? params[0] : "0x0";
          const block = Number(BigInt(tag));
          return Promise.resolve(
            body({
              number: tag,
              hash: QRL_LEG.genesisHash,
              timestamp: `0x${(T0 + block * BLOCK_TIME_S).toString(16)}`,
            }),
          );
        }
        case "eth_getLogs":
        case "qrl_getLogs": {
          const filter = params[0];
          if (
            !isRecord(filter) ||
            typeof filter.fromBlock !== "string" ||
            typeof filter.toBlock !== "string" ||
            !isArray(filter.topics)
          ) {
            return Promise.resolve(refuse("non-numeric block bound"));
          }
          const from = Number(BigInt(filter.fromBlock));
          const to = Number(BigInt(filter.toBlock));
          fake.queries.push({ leg, from, to, topics: filter.topics });
          if (leg === "qrl") {
            if (from === 0) {
              return Promise.resolve({
                ok: false,
                status: 400,
                json: () => Promise.resolve({}),
              });
            }
            if (to - from + 1 > 5_000) return Promise.resolve(refuse("range over 5000 blocks"));
          } else if (to - from + 1 > 30_000) {
            return Promise.resolve(refuse("getLogs request exceeded max allowed range"));
          }
          if (fake.failAtBlock !== null && from <= fake.failAtBlock && fake.failAtBlock <= to) {
            return Promise.resolve(refuse("upstream unavailable"));
          }
          const wanted = filter.topics[1];
          return Promise.resolve(
            body(
              fake.logs
                .filter((log) => log.leg === leg && log.block >= from && log.block <= to)
                .map((log) => ({
                  topics: [
                    leg === "qrl" ? qrvm64Topic(topicOf(log.kind)) : topicOf(log.kind),
                    wanted,
                  ],
                  transactionHash: log.txHash,
                })),
            ),
          );
        }
        default:
          return Promise.resolve(refuse(`unsupported ${method}`));
      }
    }),
  );
}

describe("swapEventsNotBeforeS", () => {
  const state = (status: LegState["status"], timeout: number) => ({ status, timeout });
  it("is the earliest timeout among the legs that hold a lock, minus 48 hours", () => {
    expect(
      swapEventsNotBeforeS([
        state(SwapStatus.Open, 5_000_000),
        state(SwapStatus.Claimed, 4_000_000),
      ]),
    ).toBe(4_000_000 - PRELOCK_INITIATOR_TIMEOUT_S);
  });

  it("ignores legs with no lock and unreadable legs", () => {
    expect(
      swapEventsNotBeforeS([
        state(SwapStatus.None, 1),
        null,
        undefined,
        state(SwapStatus.Open, 9_000_000),
      ]),
    ).toBe(9_000_000 - PRELOCK_INITIATOR_TIMEOUT_S);
  });

  it("is null when no leg holds a lock", () => {
    expect(swapEventsNotBeforeS([state(SwapStatus.None, 1), null, undefined])).toBeNull();
  });
});

describe("getSwapEvents under the endpoints' real limits", () => {
  it("makes no request when no leg holds a lock", async () => {
    const fake = newFake();
    stub(fake);
    await expect(getSwapEvents("eth", HASHLOCK, null)).resolves.toEqual([]);
    await expect(getSwapEvents("qrl", HASHLOCK, null)).resolves.toEqual([]);
    expect(fake.requests).toEqual([]);
  });

  for (const leg of ["eth", "qrl"] as const) {
    it(`finds events in the first and in the last chunk on the ${leg} leg`, async () => {
      const first = Math.floor((NOT_BEFORE_S - 86_400 - T0) / BLOCK_TIME_S);
      const fake = newFake([
        { leg, block: first + 1, kind: "Locked", txHash: "0xaa" },
        { leg, block: HEAD, kind: "Claimed", txHash: "0xbb" },
      ]);
      stub(fake);
      await expect(getSwapEvents(leg, HASHLOCK, NOT_BEFORE_S)).resolves.toEqual([
        { kind: "locked", txHash: "0xaa" },
        { kind: "claimed", txHash: "0xbb" },
      ]);
      const mine = fake.queries.filter((q) => q.leg === leg);
      expect(mine[0]?.from).toBeGreaterThan(0);
      expect(mine.every((q) => q.to - q.from + 1 <= CREDIT_LOG_CHUNK_BLOCKS)).toBe(true);
      expect(mine.at(-1)?.to).toBe(HEAD);
      expect(mine[0]?.topics).toEqual([null, leg === "qrl" ? qrvm64Topic(HASHLOCK) : HASHLOCK]);
    });
  }

  it("fails the whole lookup when one chunk fails", async () => {
    const fake = newFake([{ leg: "eth", block: HEAD, kind: "Claimed", txHash: "0xbb" }]);
    fake.failAtBlock = HEAD - 7_000;
    stub(fake);
    await expect(getSwapEvents("eth", HASHLOCK, NOT_BEFORE_S)).rejects.toThrow();
  });
});
