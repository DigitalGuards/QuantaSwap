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

/** Credited-by-this-swap amounts, keyed leg:token:account. */
const credits = new Map<string, bigint>();
/** Extra ledger balance from other swaps, same key. */
const foreignCredits = new Map<string, bigint>();
/** Keys whose read should fail, to exercise the unconfirmed state. */
const unreadable = new Set<string>();
/** Per-leg on-chain status, mutable so a test can settle a leg mid-run. */
const legStatus: Record<"eth" | "qrl", number> = { eth: 2, qrl: 2 };

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
  const stateFor = (leg: "eth" | "qrl"): LegState => {
    const base = leg === "eth" ? claimedEth : claimedQrl;
    const status = legStatus[leg] as LegState["status"];
    return status === actual.SwapStatus.Claimed
      ? base
      : { ...base, status, preimage: `0x${"0".repeat(64)}` };
  };
  return {
    ...actual,
    getLegState: vi.fn(async (leg: "eth" | "qrl") => stateFor(leg)),
    getConfirmedLegState: vi.fn(async (leg: "eth" | "qrl") => stateFor(leg)),
    getSwapEvents: vi.fn(async () => []),
    readSwapCredit: vi.fn(async (leg: string, token: string, account: string) => {
      const key = `${leg}:${token.toLowerCase()}:${account.toLowerCase()}`;
      if (unreadable.has(leg)) throw new Error("offline test");
      const credited = credits.get(key) ?? 0n;
      return { global: credited + (foreignCredits.get(key) ?? 0n), credited };
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
  foreignCredits.clear();
  unreadable.clear();
  legStatus.eth = 2;
  legStatus.qrl = 2;
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

  it("offers a push for our own credit when another wallet is connected", async () => {
    // withdrawAll reads msg.sender, so a wallet that does not hold the credit
    // cannot name a destination. The push still pays the credited address.
    credits.set(`eth:${NATIVE_TOKEN.toLowerCase()}:${TAKER_ETH.toLowerCase()}`, ETH_AMOUNT);
    render(
      <MemoryRouter>
        <SwapFlow
          swap={swap("taker")}
          ethAccount={`0x${"9".repeat(40)}`}
          qrlAccount={TAKER_QRL}
          browserProvider={null}
          ensureSepolia={vi.fn()}
          qrlRequest={vi.fn()}
          qrlTransport={null}
          onDiscard={vi.fn()}
        />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId("payout-credits")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Withdraw" })).toBeNull();
    expect(screen.getByRole("button", { name: "Push to recipient" })).toBeTruthy();
    expect(screen.getByText(/only the wallet holding it can choose where it goes/)).toBeTruthy();
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
    await waitFor(() => expect(screen.getByText(/Enter a 20-byte Ethereum address/)).toBeTruthy());
    // Nothing was sent: the wallet was never asked, and the credit stands.
    expect(screen.getByText("1.0 ETH")).toBeTruthy();
  });

  it("stops the completion banner reading as funds received", async () => {
    credits.set(`eth:${NATIVE_TOKEN.toLowerCase()}:${TAKER_ETH.toLowerCase()}`, ETH_AMOUNT);
    renderFlow("taker");
    await waitFor(() => expect(screen.getByTestId("payout-credits")).toBeTruthy());
    expect(screen.getByText(/with a payout still to collect below/)).toBeTruthy();
  });

  it("withholds the completion banner until the payout read lands", async () => {
    // An empty reading map and a delivered payout are the same shape, so a
    // green "complete" before the read completes would assert the funds
    // arrived on no evidence.
    unreadable.add("eth");
    unreadable.add("qrl");
    renderFlow("taker");
    await waitFor(() =>
      expect(screen.getByText(/Confirming the payouts actually landed/)).toBeTruthy(),
    );
    expect(screen.queryByText("Atomic swap complete on both chains")).toBeNull();
    expect(screen.queryByTestId("payout-credits")).toBeNull();
  });

  it("hides a ledger balance this swap did not credit", async () => {
    // creditOf is shared across every swap that address settled. Another
    // swap's balance must never be shown, and never offered a push, here.
    foreignCredits.set(`eth:${NATIVE_TOKEN.toLowerCase()}:${TAKER_ETH.toLowerCase()}`, ETH_AMOUNT);
    renderFlow("taker");
    await waitFor(() =>
      expect(screen.getByText("Atomic swap complete on both chains")).toBeTruthy(),
    );
    expect(screen.queryByTestId("payout-credits")).toBeNull();
  });

  it("labels the rest of the ledger balance when this swap owns part of it", async () => {
    credits.set(`eth:${NATIVE_TOKEN.toLowerCase()}:${TAKER_ETH.toLowerCase()}`, ETH_AMOUNT);
    foreignCredits.set(
      `eth:${NATIVE_TOKEN.toLowerCase()}:${TAKER_ETH.toLowerCase()}`,
      ETH_AMOUNT * 2n,
    );
    renderFlow("taker");
    await waitFor(() => expect(screen.getByTestId("payout-credits")).toBeTruthy());
    expect(screen.getByText("1.0 ETH")).toBeTruthy();
    expect(screen.getByText(/2.0 ETH from other swaps/)).toBeTruthy();
  });

  it("asks for a wallet before offering either exit", async () => {
    credits.set(`eth:${NATIVE_TOKEN.toLowerCase()}:${TAKER_ETH.toLowerCase()}`, ETH_AMOUNT);
    render(
      <MemoryRouter>
        <SwapFlow
          swap={swap("taker")}
          ethAccount={null}
          qrlAccount={null}
          browserProvider={null}
          ensureSepolia={vi.fn()}
          qrlRequest={vi.fn()}
          qrlTransport={null}
          onDiscard={vi.fn()}
        />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId("payout-credits")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Withdraw" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Push to recipient" })).toBeNull();
    expect(screen.getByText(/Connect a wallet on Sepolia to move this credit/)).toBeTruthy();
  });

  it("keeps watching until every leg has settled", async () => {
    // The ordinary sponsored-claim shape: our leg settles first, the
    // counterparty settles theirs afterwards, and that settlement defers.
    // Going quiet after the first one would miss it and paint the swap green.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      legStatus.qrl = 1; // still Open
      renderFlow("taker");
      // The ETH leg is settled and clear, so the poll would otherwise fall
      // silent here: nothing is complete and no credit exists yet.
      await vi.advanceTimersByTimeAsync(6000);
      expect(screen.queryByTestId("payout-credits")).toBeNull();
      expect(screen.queryByTestId("swap-outcome")).toBeNull();
      // The counterparty now settles our QRL leg, and its payout defers.
      legStatus.qrl = 2;
      credits.set(`qrl:${QRL_NATIVE_TOKEN.toLowerCase()}:${MAKER_QRL.toLowerCase()}`, QRL_AMOUNT);
      await vi.advanceTimersByTimeAsync(6000);
      await vi.advanceTimersByTimeAsync(6000);
      expect(screen.getByTestId("payout-credits")).toBeTruthy();
      expect(screen.getByText(/with a payout still to collect below/)).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("says the swap is final either way", async () => {
    credits.set(`qrl:${QRL_NATIVE_TOKEN.toLowerCase()}:${MAKER_QRL.toLowerCase()}`, QRL_AMOUNT);
    renderFlow("maker");
    await waitFor(() => expect(screen.getByTestId("payout-credits")).toBeTruthy());
    expect(screen.getByText(/The swap is final either way/)).toBeTruthy();
    expect(screen.getByText(/nobody else can redirect it/)).toBeTruthy();
  });
});
