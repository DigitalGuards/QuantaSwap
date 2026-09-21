import { describe, expect, it, vi } from "vitest";
import type { ActiveSwap, MyOrderRef } from "@/lib/activeSwap";
import type { OrderView } from "@/lib/orderbook";
import { reconcileMakerAnnouncement } from "./useAnnounceReconcile";

const myOrder: MyOrderRef = {
  id: "order-1",
  bookId: "community",
  token: "aa".repeat(32),
  direction: "eth->qrl",
  asset: "ETH",
  fromAmount: "1",
  toAmount: "2",
  shareToken: "bb".repeat(32),
  prelock: null,
};

const swap: ActiveSwap = {
  role: "maker",
  termsBindingVersion: 1,
  orderId: myOrder.id,
  bookId: "community",
  takerToken: null,
  direction: "eth->qrl",
  ethAsset: "ETH",
  fromAmount: "1",
  toAmount: "2",
  makerEthAccount: `0x${"11".repeat(20)}`,
  makerQrlAccount: `Q${"22".repeat(20)}`,
  takerEthAccount: `0x${"33".repeat(20)}`,
  takerQrlAccount: `Q${"44".repeat(20)}`,
  preimage: `0x${"55".repeat(32)}`,
  hashlock: `0x${"66".repeat(32)}`,
  initiatorTimeout: 1_800_007_200,
  responderTimeout: 1_800_003_600,
  createdAt: 1_800_000_000,
};

const order = {
  id: myOrder.id,
  status: "accepted",
} as OrderView;

describe("maker announcement recovery", () => {
  it("keeps private reads and mutations on the saved order origin", async () => {
    const get = vi.fn(async () => order);
    const announce = vi.fn(async () => ({ ...order, status: "locking" as const }));
    const assertProgress = vi.fn();

    await reconcileMakerAnnouncement(swap, myOrder, {
      getOrder: get,
      announceHashlock: announce,
      assertMakerOrderProgress: assertProgress,
    });

    expect(get).toHaveBeenCalledWith(myOrder.id, myOrder.shareToken, "community");
    expect(announce).toHaveBeenCalledWith(
      myOrder.id,
      {
        token: myOrder.token,
        hashlock: swap.hashlock,
        initiatorTimeout: swap.initiatorTimeout,
        responderTimeout: swap.responderTimeout,
      },
      "community",
    );
    expect(assertProgress).toHaveBeenCalledTimes(2);
  });
});
