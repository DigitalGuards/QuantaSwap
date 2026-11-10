// @vitest-environment jsdom
// Releasing the pre-funded escrow of a listing that left the book confirms
// the payout from chain before the handle is cleared. The credit log scan
// for that read starts at the escrow's own stage time, which every handle
// carries through T1, including a legacy handle with no order proof.

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PRELOCK_INITIATOR_TIMEOUT_S } from "@/config";
import type { MyOrderRef } from "@/lib/activeSwap";
import type { MakerOrderAuthV1 } from "@/lib/orderbook";

const ETH_ACCOUNT = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const QRL_ACCOUNT = `Q${"c".repeat(128)}`;
const HASHLOCK = `0x${"12".repeat(32)}`;
const ISSUED_AT = 1_700_000_000;
// The stage is written a little before the order is signed, and fixes T1.
const STAGE_AT = ISSUED_AT - 90;
const T1 = STAGE_AT + PRELOCK_INITIATOR_TIMEOUT_S;

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
        timeout: T1,
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

vi.mock("@/lib/orderbook", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/orderbook")>();
  const { OrderGoneError } = await import("@/lib/orderbookClient");
  return {
    ...actual,
    getOrder: vi.fn().mockRejectedValue(new OrderGoneError("gone")),
    cancelOrder: vi.fn().mockResolvedValue(undefined),
  };
});

const { MyOrderCard } = await import("./MyOrderCard");
const { readSwapCredit } = await import("@/lib/htlc");

const auth: MakerOrderAuthV1 = {
  version: "2",
  scheme: "qrl-sign-message-v2",
  issuedAt: ISSUED_AT,
  expiresAt: ISSUED_AT + 300,
  nonce: "n",
  makerTokenCommitment: "c",
  shareTokenCommitment: "d",
  signature: "s",
  publicKey: "p",
  descriptor: "x",
};

const handle = (withAuth: boolean): MyOrderRef => ({
  id: "order-1",
  token: "t",
  direction: "eth->qrl",
  asset: "ETH",
  fromAmount: (10n ** 18n).toString(),
  toAmount: (5n * 10n ** 18n).toString(),
  shareToken: null,
  prelock: {
    hashlock: HASHLOCK,
    preimage: `0x${"34".repeat(32)}`,
    initiatorTimeout: T1,
    leg: "eth",
  },
  ...(withAuth ? { orderAuth: auth } : {}),
});

async function release(myOrder: MyOrderRef): Promise<unknown[] | undefined> {
  render(
    <MyOrderCard
      myOrder={myOrder}
      ethAccount={ETH_ACCOUNT}
      qrlAccount={QRL_ACCOUNT}
      browserProvider={null}
      ensureSepolia={vi.fn()}
      qrlRequest={vi.fn()}
      qrlTransport={null}
      qrlWalletRdns={null}
      onMatched={vi.fn()}
      onClosed={vi.fn()}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Release escrow" }));
  await waitFor(() => expect(readSwapCredit).toHaveBeenCalled(), { timeout: 8000 });
  return vi.mocked(readSwapCredit).mock.calls[0];
}

beforeEach(() => {
  chain.status = 1;
  vi.mocked(readSwapCredit).mockClear();
});
afterEach(cleanup);

describe("MyOrderCard release of an orphaned pre-funded escrow", () => {
  it("bounds the credit log scan by the escrow's stage time", async () => {
    const call = await release(handle(true));
    expect(call?.[3]).toBe(HASHLOCK);
    expect(call?.[4]).toBe(STAGE_AT);
  });

  it("gives a legacy handle with no order proof the same bound", async () => {
    const call = await release(handle(false));
    expect(call?.[3]).toBe(HASHLOCK);
    expect(call?.[4]).toBe(STAGE_AT);
  });
});
