// @vitest-environment jsdom
// When the explorer-link lookup runs: on a status change and after a failure,
// one at a time per leg. A poll tick that changes nothing starts none, a
// failure keeps the links the leg already had, and a different swap starts
// with no links.

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LegState, SwapEvent } from "@/lib/htlc";

type Reading = Pick<LegState, "status" | "timeout">;

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
const open: Reading = { status: 1, timeout: 1_900_000_000 };
const claimed: Reading = { status: 2, timeout: 1_900_000_000 };
const none: Reading = { status: 0, timeout: 0 };
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
  it("starts a different swap with no links", async () => {
    getSwapEvents.mockResolvedValueOnce([link("0xaa")]);
    const { rerender, result } = renderHook(
      ({ hashlock, qrl }) => useSwapEvents(hashlock, { qrl, eth: none }),
      { initialProps: { hashlock: HASHLOCK, qrl: open } },
    );
    await tick(0);
    expect(result.current.qrl).toEqual([link("0xaa")]);
    // The next swap holds no lock yet, so nothing is looked up for it, and
    // the first swap's links must not show under it.
    rerender({ hashlock: `0x${"34".repeat(32)}`, qrl: none });
    expect(result.current.qrl).toEqual([]);
    await tick(60_000);
    expect(result.current.qrl).toEqual([]);
    expect(getSwapEvents).toHaveBeenCalledTimes(1);
  });

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
    // A new snapshot object with the same status is only a poll tick.
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
