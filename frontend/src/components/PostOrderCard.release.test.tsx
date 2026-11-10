// @vitest-environment jsdom
// Releasing an interrupted pre-funded post confirms the payout from chain
// before retiring the record. The credit log scan for that read starts at
// the time the browser staged the escrow.

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrelockStage } from "@/lib/activeSwap";

const ETH_ACCOUNT = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const QRL_ACCOUNT = `Q${"c".repeat(128)}`;
const HASHLOCK = `0x${"12".repeat(32)}`;
const STAGED_AT = 1_700_000_000;

const chain = { status: 1 };

vi.mock("@/lib/htlc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/htlc")>();
  return {
    ...actual,
    getLegState: vi.fn(() =>
      Promise.resolve({
        status: chain.status,
        initiator: ETH_ACCOUNT,
        recipient: actual.NATIVE_TOKEN,
        token: actual.NATIVE_TOKEN,
        amount: 10n ** 18n,
        timeout: STAGED_AT + 7200,
        preimage: `0x${"0".repeat(64)}`,
      }),
    ),
    readSwapCredit: vi.fn(() => Promise.resolve({ global: 0n, credited: 0n })),
  };
});

vi.mock("@/lib/legSender", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/legSender")>();
  return {
    ...actual,
    makeSettlementSender: () => () => {
      chain.status = 3;
      return Promise.resolve();
    },
  };
});

const { PostOrderCard } = await import("./PostOrderCard");
const { readSwapCredit } = await import("@/lib/htlc");
const { PRELOCK_STORAGE_KEY } = await import("@/lib/activeSwap");

const stage: PrelockStage = {
  hashlock: HASHLOCK,
  preimage: `0x${"34".repeat(32)}`,
  initiatorTimeout: STAGED_AT + 7200,
  leg: "eth",
  direction: "eth->qrl",
  asset: "ETH",
  fromAmount: (10n ** 18n).toString(),
  toAmount: (5n * 10n ** 18n).toString(),
  visibility: "public",
  allowedTakerEth: null,
  allowedTakerQrl: null,
  createdAt: STAGED_AT,
};

beforeEach(() => {
  chain.status = 1;
  localStorage.setItem(PRELOCK_STORAGE_KEY, JSON.stringify(stage));
  vi.mocked(readSwapCredit).mockClear();
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("PostOrderCard release of a staged escrow", () => {
  it("bounds the credit log scan by the stage's own creation time", async () => {
    render(
      <PostOrderCard
        ethAccount={ETH_ACCOUNT}
        qrlAccount={QRL_ACCOUNT}
        browserProvider={null}
        ensureSepolia={vi.fn()}
        qrlRequest={vi.fn()}
        qrlTransport={null}
        qrlWalletRdns={null}
        onPosted={vi.fn()}
      />,
    );
    const button = await screen.findByRole("button", { name: "Release escrow" });
    fireEvent.click(button);
    await waitFor(() => expect(readSwapCredit).toHaveBeenCalled(), { timeout: 8000 });
    const call = vi.mocked(readSwapCredit).mock.calls[0];
    expect(call?.[3]).toBe(HASHLOCK);
    expect(call?.[4]).toBe(STAGED_AT);
  });
});
