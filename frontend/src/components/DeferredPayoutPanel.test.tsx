// @vitest-environment jsdom
// The panel the order views render after settling an escrow, and the rule it
// shares with them: what this escrow still owes is what its own hashlock was
// credited, capped by what the shared ledger still holds. Reading the ledger
// alone pins a record on another swap's credit and shows a panel with nothing
// in it, which is exactly what the caller is holding the record open for.

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CreditReading } from "@/lib/htlc";

const readings = new Map<string, CreditReading>();
const sent: { leg: string; data: string }[] = [];

vi.mock("@/lib/htlc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/htlc")>();
  return {
    ...actual,
    readSwapCredit: vi.fn(async (leg: string, token: string, account: string) => {
      const key = `${leg}:${token.toLowerCase()}:${account.toLowerCase()}`;
      return readings.get(key) ?? { global: 0n, credited: 0n };
    }),
  };
});

vi.mock("@/lib/legSender", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/legSender")>();
  return {
    ...actual,
    makeSettlementSender: () => async (leg: string, data: string) => {
      sent.push({ leg, data });
    },
  };
});

const { DeferredPayoutPanel, attributedCredit } = await import("./DeferredPayoutPanel");
const { NATIVE_TOKEN } = await import("@/lib/htlc");

const ACCOUNT = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const OTHER = "0xcccccccccccccccccccccccccccccccccccccccc";
const HASHLOCK = `0x${"12".repeat(32)}`;
const ONE_ETH = 10n ** 18n;

const target = {
  id: "eth:prelock",
  leg: "eth" as const,
  hashlock: HASHLOCK,
  token: NATIVE_TOKEN,
  account: ACCOUNT,
  symbol: "ETH",
  decimals: 18,
};

const key = `eth:${NATIVE_TOKEN.toLowerCase()}:${ACCOUNT.toLowerCase()}`;

function renderPanel(options: { ethAccount?: string | null; onCleared?: () => void } = {}) {
  return render(
    <DeferredPayoutPanel
      targets={[target]}
      ethAccount={options.ethAccount === undefined ? ACCOUNT : options.ethAccount}
      qrlAccount={null}
      browserProvider={null}
      ensureSepolia={vi.fn()}
      qrlRequest={vi.fn()}
      qrlTransport={null}
      {...(options.onCleared ? { onCleared: options.onCleared } : {})}
    />,
  );
}

beforeEach(() => {
  readings.clear();
  sent.length = 0;
});
afterEach(cleanup);

describe("attributedCredit", () => {
  it("is this swap's credit, capped by what the ledger still holds", () => {
    expect(attributedCredit({ global: ONE_ETH, credited: ONE_ETH })).toBe(ONE_ETH);
    // A balance this swap did not create belongs to another one.
    expect(attributedCredit({ global: ONE_ETH, credited: 0n })).toBe(0n);
    // A withdrawal drains the shared ledger without naming a swap.
    expect(attributedCredit({ global: ONE_ETH / 4n, credited: ONE_ETH })).toBe(ONE_ETH / 4n);
    expect(attributedCredit({ global: 0n, credited: 0n })).toBe(0n);
  });
});

describe("DeferredPayoutPanel", () => {
  it("shows nothing when this escrow's payout was delivered", async () => {
    // An unrelated old credit sits on the same address and asset. Rendering
    // it here would offer to move somebody else's money.
    readings.set(key, { global: ONE_ETH * 3n, credited: 0n });
    const onCleared = vi.fn();
    renderPanel({ onCleared });
    await waitFor(() => expect(onCleared).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("deferred-payouts")).toBeNull();
  });

  it("reports the caller's record clear as soon as this payout is out", async () => {
    readings.set(key, { global: 0n, credited: ONE_ETH });
    const onCleared = vi.fn();
    renderPanel({ onCleared });
    await waitFor(() => expect(onCleared).toHaveBeenCalled());
    expect(screen.queryByTestId("deferred-payouts")).toBeNull();
  });

  it("offers a collect for a deferred payout, and says what else is held", async () => {
    readings.set(key, { global: ONE_ETH * 3n, credited: ONE_ETH });
    const onCleared = vi.fn();
    renderPanel({ onCleared });
    await waitFor(() => expect(screen.getByTestId("deferred-payouts")).toBeTruthy());
    expect(screen.getByText(/1.0 ETH/)).toBeTruthy();
    expect(screen.getByText(/2.0 ETH from other swaps/)).toBeTruthy();
    expect(onCleared).not.toHaveBeenCalled();
    screen.getByRole("button", { name: "Collect" }).click();
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.leg).toBe("eth");
  });

  it("offers a push when another wallet is connected", async () => {
    readings.set(key, { global: ONE_ETH, credited: ONE_ETH });
    renderPanel({ ethAccount: OTHER });
    await waitFor(() => expect(screen.getByTestId("deferred-payouts")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Collect" })).toBeNull();
    expect(screen.getByRole("button", { name: "Pay it to that address" })).toBeTruthy();
  });

  it("asks for a wallet when none is attached on that leg", async () => {
    readings.set(key, { global: ONE_ETH, credited: ONE_ETH });
    renderPanel({ ethAccount: null });
    await waitFor(() => expect(screen.getByTestId("deferred-payouts")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Collect" })).toBeNull();
    expect(screen.getByText(/Connect a wallet on Sepolia/)).toBeTruthy();
  });
});
