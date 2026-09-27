// @vitest-environment jsdom
// The credit states HTLCv3 can leave a settled swap in, as the swap flow
// renders them. A Claimed leg whose delivery failed is still terminal, and
// the panel is the only place the amount is visible, so these assertions pin
// which exit each side is offered.

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

const credits = new Map<string, bigint>();

vi.mock("@/lib/htlc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/htlc")>();
  const claimedEth: LegState = {
    status: actual.SwapStatus.Claimed,
    initiator: MAKER_ETH,
    recipient: TAKER_ETH,
    token: actual.NATIVE_TOKEN,
    amount: ETH_AMOUNT,
    timeout: NOW + 7200,
    preimage: PREIMAGE,
  };
  const claimedQrl: LegState = {
    status: actual.SwapStatus.Claimed,
    initiator: `0x${TAKER_QRL.slice(1)}`,
    recipient: `0x${MAKER_QRL.slice(1)}`,
    token: actual.QRL_NATIVE_TOKEN,
    amount: QRL_AMOUNT,
    timeout: NOW + 3600,
    preimage: PREIMAGE,
  };
  return {
    ...actual,
    getLegState: vi.fn(async (leg: "eth" | "qrl") => (leg === "eth" ? claimedEth : claimedQrl)),
    getConfirmedLegState: vi.fn(async (leg: "eth" | "qrl") =>
      leg === "eth" ? claimedEth : claimedQrl,
    ),
    getSwapEvents: vi.fn(async () => []),
    getCredit: vi.fn(async (leg: string, token: string, account: string) => {
      const key = `${leg}:${token.toLowerCase()}:${account.toLowerCase()}`;
      return credits.get(key) ?? 0n;
    }),
  };
});

vi.mock("@/lib/orderbook", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/orderbook")>();
  return { ...actual, getOrder: vi.fn().mockRejectedValue(new Error("offline test")) };
});

const { SwapFlow } = await import("./SwapFlow");
const { NATIVE_TOKEN, QRL_NATIVE_TOKEN } = await import("@/lib/htlc");

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
  credits.clear();
});
afterEach(cleanup);

describe("deferred payout panel", () => {
  it("stays hidden while every payout was delivered", async () => {
    renderFlow("taker");
    await waitFor(() => expect(screen.getByText(/Atomic swap complete/)).toBeTruthy());
    expect(screen.queryByTestId("payout-credits")).toBeNull();
  });

  it("offers the credited account a withdrawal to a destination it names", async () => {
    credits.set(`eth:${NATIVE_TOKEN.toLowerCase()}:${TAKER_ETH.toLowerCase()}`, ETH_AMOUNT);
    renderFlow("taker");
    await waitFor(() => expect(screen.getByTestId("payout-credits")).toBeTruthy());
    expect(screen.getByText("1.0 ETH")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Withdraw" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Push to recipient" })).toBeNull();
    const destination = screen.getByLabelText(/Withdrawal destination/);
    // Empty means the payee's own address, which is what the contract would
    // pay anyway; the placeholder says so.
    expect(destination.getAttribute("placeholder")).toBe(TAKER_ETH);
  });

  it("offers only a push for a credit owed to the counterparty", async () => {
    credits.set(`eth:${NATIVE_TOKEN.toLowerCase()}:${TAKER_ETH.toLowerCase()}`, ETH_AMOUNT);
    renderFlow("maker");
    await waitFor(() => expect(screen.getByTestId("payout-credits")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Push to recipient" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Withdraw" })).toBeNull();
    expect(screen.getByText(/cannot send their credit anywhere else/)).toBeTruthy();
  });

  it("shows a credit on each leg with its own asset", async () => {
    credits.set(`eth:${NATIVE_TOKEN.toLowerCase()}:${TAKER_ETH.toLowerCase()}`, ETH_AMOUNT);
    credits.set(`qrl:${QRL_NATIVE_TOKEN.toLowerCase()}:${MAKER_QRL.toLowerCase()}`, QRL_AMOUNT);
    renderFlow("maker");
    await waitFor(() => expect(screen.getByTestId("payout-credits")).toBeTruthy());
    expect(screen.getByText("1.0 ETH")).toBeTruthy();
    expect(screen.getByText("5.0 Quanta")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Withdraw" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Push to recipient" })).toBeTruthy();
  });

  it("names a mistyped destination before anything is signed", async () => {
    credits.set(`eth:${NATIVE_TOKEN.toLowerCase()}:${TAKER_ETH.toLowerCase()}`, ETH_AMOUNT);
    renderFlow("taker");
    await waitFor(() => expect(screen.getByTestId("payout-credits")).toBeTruthy());
    fireEvent.change(screen.getByLabelText(/Withdrawal destination/), {
      target: { value: "not-an-address" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Withdraw" }));
    await waitFor(() =>
      expect(screen.getByText(/Enter a 20-byte Ethereum address/)).toBeTruthy(),
    );
    // Nothing was sent: the wallet was never asked, and the credit stands.
    expect(screen.getByText("1.0 ETH")).toBeTruthy();
  });

  it("stops the completion banner reading as funds received", async () => {
    credits.set(`eth:${NATIVE_TOKEN.toLowerCase()}:${TAKER_ETH.toLowerCase()}`, ETH_AMOUNT);
    renderFlow("taker");
    await waitFor(() => expect(screen.getByTestId("payout-credits")).toBeTruthy());
    expect(screen.getByText(/with a payout still to collect below/)).toBeTruthy();
  });

  it("says the swap is final either way", async () => {
    credits.set(`qrl:${QRL_NATIVE_TOKEN.toLowerCase()}:${MAKER_QRL.toLowerCase()}`, QRL_AMOUNT);
    renderFlow("maker");
    await waitFor(() => expect(screen.getByTestId("payout-credits")).toBeTruthy());
    expect(screen.getByText(/The swap is final either way/)).toBeTruthy();
    expect(screen.getByText(/nobody else can redirect it/)).toBeTruthy();
  });
});
