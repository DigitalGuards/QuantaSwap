// @vitest-environment jsdom
// The "what happens next" line and the live-step markers of the swap flow.

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LegState } from "@/lib/htlc";
import type { ActiveSwap } from "@/lib/activeSwap";

const MAKER_ETH = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TAKER_ETH = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const MAKER_QRL = `Q${"c".repeat(128)}`;
const TAKER_QRL = `Q${"d".repeat(128)}`;
const HASHLOCK = `0x${"12".repeat(32)}`;
const PREIMAGE = `0x${"34".repeat(32)}`;
const NOW = Math.floor(Date.now() / 1000);
const ETH_AMOUNT = 10n ** 18n;
const QRL_AMOUNT = 5n * 10n ** 18n;

/** Per-leg on-chain status: 0 none, 1 open, 2 claimed. */
const legStatus: Record<"eth" | "qrl", LegState["status"]> = { eth: 0, qrl: 0 };

vi.mock("@/lib/htlc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/htlc")>();
  const stateFor = (leg: "eth" | "qrl"): LegState => {
    const status: LegState["status"] = legStatus[leg];
    const eth = leg === "eth";
    return {
      status,
      initiator: eth ? MAKER_ETH : `0x${TAKER_QRL.slice(1)}`,
      recipient: eth ? TAKER_ETH : `0x${MAKER_QRL.slice(1)}`,
      token: eth ? actual.NATIVE_TOKEN : actual.QRL_NATIVE_TOKEN,
      amount: eth ? ETH_AMOUNT : QRL_AMOUNT,
      timeout: NOW + (eth ? 7200 : 3600),
      preimage: status === actual.SwapStatus.Claimed ? PREIMAGE : `0x${"0".repeat(64)}`,
    };
  };
  return {
    ...actual,
    getLegState: vi.fn((leg: "eth" | "qrl") => Promise.resolve(stateFor(leg))),
    getConfirmedLegState: vi.fn((leg: "eth" | "qrl") => Promise.resolve(stateFor(leg))),
    getSwapEvents: vi.fn(() => Promise.resolve([])),
    readSwapCredit: vi.fn(() => Promise.resolve({ global: 0n, credited: 0n })),
  };
});

vi.mock("@/lib/orderbook", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/orderbook")>();
  return { ...actual, getOrder: vi.fn().mockRejectedValue(new Error("offline test")) };
});

const { SwapFlow } = await import("./SwapFlow");

const swap = (role: ActiveSwap["role"]): ActiveSwap => ({
  role,
  termsBindingVersion: 1,
  orderId: "order-1",
  takerToken: null,
  direction: "eth->qrl",
  ethAsset: "ETH",
  fromAmount: ETH_AMOUNT.toString(),
  toAmount: QRL_AMOUNT.toString(),
  makerEthAccount: MAKER_ETH,
  makerQrlAccount: MAKER_QRL,
  takerEthAccount: TAKER_ETH,
  takerQrlAccount: TAKER_QRL,
  preimage: role === "taker" ? null : PREIMAGE,
  hashlock: HASHLOCK,
  initiatorTimeout: NOW + 7200,
  responderTimeout: NOW + 3600,
  createdAt: NOW - 60,
});

function renderFlow(role: ActiveSwap["role"]) {
  return render(
    <MemoryRouter>
      <SwapFlow
        swap={swap(role)}
        ethAccount={role === "taker" ? TAKER_ETH : MAKER_ETH}
        qrlAccount={role === "taker" ? TAKER_QRL : MAKER_QRL}
        browserProvider={null}
        ensureSepolia={vi.fn()}
        qrlRequest={vi.fn()}
        qrlTransport={null}
        onDiscard={vi.fn()}
      />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  legStatus.eth = 0;
  legStatus.qrl = 0;
});
afterEach(cleanup);

describe("swap progress line", () => {
  it("tells the taker there is nothing to do while the maker has to claim", async () => {
    legStatus.eth = 1;
    legStatus.qrl = 1;
    renderFlow("taker");
    const line = await screen.findByTestId("swap-now");
    expect(line.getAttribute("role")).toBe("status");
    expect(line.getAttribute("aria-live")).toBe("polite");
    expect(line.textContent).toContain("Nothing to do right now.");
    expect(line.textContent).toContain("Waiting for the maker to claim and reveal the secret");
    expect(line.textContent).toContain("reopen this swap link later");
  });

  it("tells the taker it is their turn once the secret is revealed", async () => {
    legStatus.eth = 1;
    legStatus.qrl = 2;
    renderFlow("taker");
    await waitFor(() =>
      expect(screen.getByTestId("swap-now").textContent).toMatch(/^Your turn: Claim/),
    );
  });

  it("shows a note instead of a dead button for a later own step", async () => {
    renderFlow("taker");
    await screen.findByTestId("swap-now");
    const notes = screen.getAllByTestId("step-later");
    expect(notes).toHaveLength(2);
    expect(notes[0]?.textContent).toBe("Available after step 1.");
    expect(screen.queryByRole("button", { name: /^Lock/ })).toBeNull();
  });

  it("hides the line once both legs are claimed", async () => {
    legStatus.eth = 2;
    legStatus.qrl = 2;
    renderFlow("taker");
    await waitFor(() => expect(screen.getByText(/Atomic swap complete/)).toBeTruthy());
    expect(screen.queryByTestId("swap-now")).toBeNull();
  });
});
