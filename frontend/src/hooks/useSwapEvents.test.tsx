// @vitest-environment jsdom
// When the explorer-link lookup runs: on a status change and after a failure,
// never on every poll, one at a time per leg, and a failure keeps the links
// the leg already had.

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SwapEvent } from "@/lib/htlc";

const getSwapEvents =
  vi.fn<(leg: string, hashlock: string, notBeforeS: number | null) => Promise<SwapEvent[]>>();

vi.mock("@/lib/htlc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/htlc")>();
  return {
    ...actual,
    getSwapEvents: (...args: Parameters<typeof getSwapEvents>) => getSwapEvents(...args),
  };
});

const { useSwapEvents, SWAP_EVENTS_RETRY_MS } = await import("./useSwapEvents");

const HASHLOCK = `0x${"12".repeat(32)}`;
const open = { status: 1, timeout: 1_900_000_000 } as const;
const claimed = { status: 2, timeout: 1_900_000_000 } as const;
const none = { status: 0, timeout: 0 } as const;
const tick = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
const link = (txHash: string): SwapEvent => ({ kind: "locked", txHash });

beforeEach(() => {
  vi.useFakeTimers();
  getSwapEvents.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useSwapEvents", () => {
  it("asks nothing while no leg holds a lock", async () => {
    renderHook(() => useSwapEvents(HASHLOCK, { qrl: none, eth: undefined }));
    await tick(60_000);
    expect(getSwapEvents).not.toHaveBeenCalled();
  });

  it("looks up again on a status change and not while statuses stay the same", async () => {
    getSwapEvents.mockResolvedValue([link("0xaa")]);
    const { rerender, result } = renderHook(
      ({ qrl }) => useSwapEvents(HASHLOCK, { qrl, eth: none }),
      { initialProps: { qrl: open } },
    );
    await tick(0);
    expect(getSwapEvents).toHaveBeenCalledTimes(1);
    expect(result.current.qrl).toEqual([link("0xaa")]);
    // A new snapshot object with the same status is a poll tick, not a change.
    for (let i = 0; i < 5; i += 1) {
      rerender({ qrl: { ...open } });
      await tick(5_000);
    }
    expect(getSwapEvents).toHaveBeenCalledTimes(1);
    rerender({ qrl: claimed });
    await tick(0);
    expect(getSwapEvents).toHaveBeenCalledTimes(2);
  });

  it("keeps earlier links through a failed lookup and retries it later", async () => {
    getSwapEvents.mockResolvedValueOnce([link("0xaa")]);
    const { rerender, result } = renderHook(
      ({ qrl }) => useSwapEvents(HASHLOCK, { qrl, eth: none }),
      { initialProps: { qrl: open } },
    );
    await tick(0);
    getSwapEvents.mockRejectedValueOnce(new Error("range refused"));
    rerender({ qrl: claimed });
    await tick(0);
    expect(getSwapEvents).toHaveBeenCalledTimes(2);
    expect(result.current.qrl).toEqual([link("0xaa")]);
    getSwapEvents.mockResolvedValueOnce([link("0xaa"), link("0xbb")]);
    await tick(SWAP_EVENTS_RETRY_MS - 1);
    expect(getSwapEvents).toHaveBeenCalledTimes(2);
    await tick(1);
    expect(getSwapEvents).toHaveBeenCalledTimes(3);
    expect(result.current.qrl).toEqual([link("0xaa"), link("0xbb")]);
  });

  it("never runs two lookups for one leg at the same time", async () => {
    let running = 0;
    let peak = 0;
    getSwapEvents.mockImplementation(async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 1_000);
      });
      running -= 1;
      return [];
    });
    const { rerender } = renderHook(({ qrl }) => useSwapEvents(HASHLOCK, { qrl, eth: none }), {
      initialProps: { qrl: open },
    });
    await tick(100);
    rerender({ qrl: claimed });
    await tick(5_000);
    expect(getSwapEvents).toHaveBeenCalledTimes(2);
    expect(peak).toBe(1);
  });
});
