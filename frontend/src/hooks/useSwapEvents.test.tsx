// @vitest-environment jsdom
// When the explorer-link lookup runs: when a leg's status or recipient
// changes and after a failure, each leg on its own and one lookup at a time.
// A poll tick that changes nothing starts none, and neither does a failed
// leg read. A failure keeps the links the leg already had and waits longer
// each time, and a different swap starts with no links.

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LegState, SwapEvent } from "@/lib/htlc";

type Reading = Pick<LegState, "status" | "timeout" | "recipient">;

const getSwapEvents =
  vi.fn<(leg: string, hashlock: string, notBeforeS: number | null) => Promise<SwapEvent[]>>();

vi.mock("@/lib/htlc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/htlc")>();
  return {
    ...actual,
    getSwapEvents: (...args: Parameters<typeof getSwapEvents>) => getSwapEvents(...args),
  };
});

const { useSwapEvents, SWAP_EVENTS_RETRY_MS, SWAP_EVENTS_RETRY_MAX_MS } =
  await import("./useSwapEvents");

const HASHLOCK = `0x${"12".repeat(32)}`;
const NOBODY = `0x${"0".repeat(40)}`;
const TAKER = `0x${"b".repeat(40)}`;
const open: Reading = { status: 1, timeout: 1_900_000_000, recipient: TAKER };
const claimed: Reading = { status: 2, timeout: 1_900_000_000, recipient: TAKER };
const none: Reading = { status: 0, timeout: 0, recipient: NOBODY };
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

  it("looks up again when an open lock gets its recipient", async () => {
    // assign() names the recipient of a pre-funded lock. Status and timeout
    // stay as they were, and the Assigned event is new.
    getSwapEvents.mockResolvedValue([link("0xaa")]);
    const { rerender } = renderHook(({ qrl }) => useSwapEvents(HASHLOCK, { qrl, eth: none }), {
      initialProps: { qrl: { ...open, recipient: NOBODY } },
    });
    await tick(0);
    expect(getSwapEvents).toHaveBeenCalledTimes(1);
    rerender({ qrl: { ...open, recipient: TAKER } });
    await tick(0);
    expect(getSwapEvents).toHaveBeenCalledTimes(2);
  });

  it("looks up only the leg that changed", async () => {
    getSwapEvents.mockResolvedValue([]);
    const { rerender } = renderHook(({ eth }) => useSwapEvents(HASHLOCK, { qrl: open, eth }), {
      initialProps: { eth: open },
    });
    await tick(0);
    expect(getSwapEvents.mock.calls.map((call) => call[0]).sort()).toEqual(["eth", "qrl"]);
    getSwapEvents.mockClear();
    rerender({ eth: claimed });
    await tick(0);
    expect(getSwapEvents.mock.calls.map((call) => call[0])).toEqual(["eth"]);
  });

  it("starts no lookup when a leg read fails and then returns unchanged", async () => {
    getSwapEvents.mockResolvedValue([link("0xaa")]);
    const initialProps: { qrl: Reading | null } = { qrl: open };
    const { rerender, result } = renderHook(
      ({ qrl }: { qrl: Reading | null }) => useSwapEvents(HASHLOCK, { qrl, eth: open }),
      { initialProps },
    );
    await tick(0);
    expect(getSwapEvents).toHaveBeenCalledTimes(2);
    rerender({ qrl: null });
    await tick(5_000);
    rerender({ qrl: { ...open } });
    await tick(5_000);
    expect(getSwapEvents).toHaveBeenCalledTimes(2);
    expect(result.current.qrl).toEqual([link("0xaa")]);
  });

  it("waits twice as long after each failure in a row, up to the cap", async () => {
    getSwapEvents.mockRejectedValue(new Error("range refused"));
    renderHook(() => useSwapEvents(HASHLOCK, { qrl: open, eth: none }));
    await tick(0);
    expect(getSwapEvents).toHaveBeenCalledTimes(1);
    let wait = SWAP_EVENTS_RETRY_MS;
    for (let attempt = 2; attempt <= 7; attempt += 1) {
      await tick(wait - 1);
      expect(getSwapEvents).toHaveBeenCalledTimes(attempt - 1);
      await tick(1);
      expect(getSwapEvents).toHaveBeenCalledTimes(attempt);
      wait = Math.min(wait * 2, SWAP_EVENTS_RETRY_MAX_MS);
    }
    expect(wait).toBe(SWAP_EVENTS_RETRY_MAX_MS);
  });

  it("starts the wait over when the chain state changes", async () => {
    getSwapEvents.mockRejectedValue(new Error("range refused"));
    const { rerender } = renderHook(({ qrl }) => useSwapEvents(HASHLOCK, { qrl, eth: none }), {
      initialProps: { qrl: open },
    });
    await tick(0);
    await tick(SWAP_EVENTS_RETRY_MS);
    await tick(SWAP_EVENTS_RETRY_MS * 2);
    expect(getSwapEvents).toHaveBeenCalledTimes(3);
    rerender({ qrl: claimed });
    await tick(0);
    expect(getSwapEvents).toHaveBeenCalledTimes(4);
    await tick(SWAP_EVENTS_RETRY_MS);
    expect(getSwapEvents).toHaveBeenCalledTimes(5);
  });

  it("does not make a different swap wait for the scan of the swap before it", async () => {
    const other = `0x${"56".repeat(32)}`;
    // The first swap's scan never ends within this test.
    getSwapEvents.mockImplementationOnce(() => new Promise<SwapEvent[]>(() => undefined));
    getSwapEvents.mockResolvedValue([link("0xbb")]);
    const { rerender, result } = renderHook(
      ({ hashlock }) => useSwapEvents(hashlock, { qrl: open, eth: none }),
      { initialProps: { hashlock: HASHLOCK } },
    );
    await tick(0);
    expect(getSwapEvents).toHaveBeenCalledTimes(1);
    rerender({ hashlock: other });
    await tick(0);
    expect(getSwapEvents).toHaveBeenCalledTimes(2);
    expect(getSwapEvents.mock.calls[1]?.[1]).toBe(other);
    expect(result.current.qrl).toEqual([link("0xbb")]);
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
