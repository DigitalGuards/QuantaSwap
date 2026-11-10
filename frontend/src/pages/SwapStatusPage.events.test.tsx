// @vitest-environment jsdom
// The public status page polls both legs every few seconds. The explorer-link
// lookup behind it runs when a leg's status changes, not on every poll.

import { act, cleanup, render } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LegState } from "@/lib/htlc";
import type { SwapEvent } from "@/lib/htlc";

const HASHLOCK = `0x${"12".repeat(32)}`;
const status: Record<"qrl" | "eth", LegState["status"]> = { qrl: 1, eth: 1 };

vi.mock("@/lib/htlc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/htlc")>();
  const state = (leg: "qrl" | "eth"): LegState => ({
    status: status[leg],
    initiator: leg === "qrl" ? actual.QRL_NATIVE_TOKEN : actual.NATIVE_TOKEN,
    recipient: leg === "qrl" ? actual.QRL_NATIVE_TOKEN : actual.NATIVE_TOKEN,
    token: leg === "qrl" ? actual.QRL_NATIVE_TOKEN : actual.NATIVE_TOKEN,
    amount: 10n ** 18n,
    timeout: 1_900_000_000,
    preimage: `0x${"0".repeat(64)}`,
  });
  return {
    ...actual,
    getLegState: vi.fn((leg: "qrl" | "eth") => Promise.resolve(state(leg))),
    getSwapEvents: vi.fn((): Promise<SwapEvent[]> => Promise.resolve([])),
  };
});

const { SwapStatusPage } = await import("./SwapStatusPage");
const { useEthWallet } = await import("@/hooks/useEthWallet");
const { useQrlWallet } = await import("@/hooks/useQrlWallet");
const { getSwapEvents } = await import("@/lib/htlc");

const tick = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

/** The page takes the two wallet hooks as props, as App does. */
function Page() {
  const eth = useEthWallet();
  const qrl = useQrlWallet();
  return <SwapStatusPage eth={eth} qrl={qrl} swap={null} setSwap={vi.fn()} />;
}

function mount() {
  return render(
    <MemoryRouter initialEntries={[`/swap/${HASHLOCK}`]}>
      <Routes>
        <Route path="/swap/:hashlock" element={<Page />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  status.qrl = 1;
  status.eth = 1;
  vi.mocked(getSwapEvents).mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("SwapStatusPage explorer links", () => {
  it("does not repeat the lookup while the statuses are unchanged", async () => {
    mount();
    await tick(0);
    const first = vi.mocked(getSwapEvents).mock.calls.length;
    expect(first).toBeGreaterThan(0);
    await tick(30_000);
    expect(vi.mocked(getSwapEvents).mock.calls.length).toBe(first);
  });

  it("looks up again when a leg's status changes, with the chain-derived bound", async () => {
    mount();
    await tick(0);
    const before = vi.mocked(getSwapEvents).mock.calls.length;
    status.qrl = 2;
    await tick(5_000);
    expect(vi.mocked(getSwapEvents).mock.calls.length).toBeGreaterThan(before);
    for (const call of vi.mocked(getSwapEvents).mock.calls) {
      expect(call[2]).toBe(1_900_000_000 - 48 * 3600);
    }
  });
});
