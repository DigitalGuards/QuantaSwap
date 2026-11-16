// @vitest-environment jsdom
// The in-progress swap screen carries no "Live contracts" card.

import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActiveSwap } from "@/lib/activeSwap";
import type { LegState } from "@/lib/htlc";

const HASHLOCK = `0x${"12".repeat(32)}`;

vi.mock("@/lib/htlc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/htlc")>();
  const state = (): LegState => ({
    status: 1,
    initiator: actual.NATIVE_TOKEN,
    recipient: actual.NATIVE_TOKEN,
    token: actual.NATIVE_TOKEN,
    amount: 10n ** 18n,
    timeout: 1_900_000_000,
    preimage: `0x${"0".repeat(64)}`,
  });
  return {
    ...actual,
    getLegState: vi.fn(() => Promise.resolve(state())),
    getSwapEvents: vi.fn(() => Promise.resolve([])),
    getBlockNumber: vi.fn().mockRejectedValue(new Error("offline test")),
  };
});

vi.mock("@/components/SwapFlow", () => ({
  SwapFlow: () => <div data-testid="swap-flow-stub" />,
}));

const { SwapStatusPage } = await import("./SwapStatusPage");
const { useEthWallet } = await import("@/hooks/useEthWallet");
const { useQrlWallet } = await import("@/hooks/useQrlWallet");

function Page({ swap }: { swap: ActiveSwap | null }) {
  const eth = useEthWallet();
  const qrl = useQrlWallet();
  return <SwapStatusPage eth={eth} qrl={qrl} swap={swap} setSwap={vi.fn()} />;
}

const mount = (swap: ActiveSwap | null) =>
  render(
    <MemoryRouter initialEntries={[`/swap/${HASHLOCK}`]}>
      <Routes>
        <Route path="/swap/:hashlock" element={<Page swap={swap} />} />
      </Routes>
    </MemoryRouter>,
  );

afterEach(cleanup);

describe("SwapStatusPage contracts card", () => {
  it("is absent on the interactive in-progress view", async () => {
    const own: ActiveSwap = {
      role: "taker",
      termsBindingVersion: 1,
      orderId: "order-1",
      takerToken: null,
      direction: "eth->qrl",
      ethAsset: "ETH",
      fromAmount: "1",
      toAmount: "1",
      makerEthAccount: `0x${"aa".repeat(20)}`,
      makerQrlAccount: `Q${"c".repeat(128)}`,
      takerEthAccount: `0x${"bb".repeat(20)}`,
      takerQrlAccount: `Q${"d".repeat(128)}`,
      preimage: null,
      hashlock: HASHLOCK,
      initiatorTimeout: 1_900_000_000,
      responderTimeout: 1_899_990_000,
      createdAt: 1_800_000_000,
    };
    mount(own);
    await screen.findByTestId("swap-flow-stub");
    expect(screen.queryByText("Live contracts")).toBeNull();
  });
});
