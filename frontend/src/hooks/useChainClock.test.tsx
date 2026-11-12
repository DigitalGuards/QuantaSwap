// @vitest-environment jsdom
// The chain lookups retry per key, and a null answer counts as a failed try.

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
const answer: { value: string | null } = { value: null };

vi.mock("@/lib/htlc", () => ({
  getChainClockReading: vi.fn(),
  getTxSender: vi.fn((_leg: string, hash: string) => {
    calls.push(hash);
    return Promise.resolve(answer.value);
  }),
}));

const { useTxSender, CHAIN_READ_RETRY_MS } = await import("./useChainClock");

/** Steps of one retry wait, so React commits between the retries. */
const advance = async (ms: number) => {
  for (let left = ms; left > 0; left -= CHAIN_READ_RETRY_MS) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(Math.min(left, CHAIN_READ_RETRY_MS));
    });
  }
};

beforeEach(() => {
  vi.useFakeTimers();
  calls.length = 0;
  answer.value = null;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useTxSender", () => {
  it("asks again after a null answer and returns the sender once the node knows it", async () => {
    const { result } = renderHook(() => useTxSender("qrl", "0xaa"));
    await advance(1);
    expect(result.current).toBeUndefined();
    answer.value = "0x01";
    await advance(CHAIN_READ_RETRY_MS + 1);
    expect(result.current).toBe("0x01");
    expect(calls).toEqual(["0xaa", "0xaa"]);
  });

  it("stops after five tries", async () => {
    renderHook(() => useTxSender("qrl", "0xaa"));
    await advance(CHAIN_READ_RETRY_MS * 10);
    expect(calls).toHaveLength(5);
  });

  it("counts retries per key, so a new key gets its own five tries", async () => {
    const { rerender } = renderHook(({ hash }) => useTxSender("qrl", hash), {
      initialProps: { hash: "0xaa" },
    });
    await advance(CHAIN_READ_RETRY_MS * 3 + 1);
    expect(calls.filter((c) => c === "0xaa")).toHaveLength(4);
    rerender({ hash: "0xbb" });
    await advance(CHAIN_READ_RETRY_MS * 10);
    expect(calls.filter((c) => c === "0xbb")).toHaveLength(5);
  });
});
