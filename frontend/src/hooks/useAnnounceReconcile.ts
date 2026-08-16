import { useEffect, useRef } from "react";
import {
  clearMyOrder,
  loadMyOrder,
  type ActiveSwap,
  type MyOrderRef,
} from "@/lib/activeSwap";
import {
  announceHashlock,
  assertMakerOrderProgress,
  getOrder,
  OrderGoneError,
  type OrderView,
} from "@/lib/orderbook";

interface AnnounceReconcileDependencies {
  getOrder: (
    id: string,
    shareToken: string | undefined,
    bookId: string,
  ) => Promise<OrderView>;
  announceHashlock: (
    id: string,
    body: {
      token: string;
      hashlock: string;
      initiatorTimeout: number;
      responderTimeout: number;
    },
    bookId: string,
  ) => Promise<OrderView>;
  assertMakerOrderProgress: (
    local: MyOrderRef,
    stored: ActiveSwap,
    current: OrderView,
  ) => void;
}

const defaultDependencies: AnnounceReconcileDependencies = {
  getOrder,
  announceHashlock,
  assertMakerOrderProgress,
};

export async function reconcileMakerAnnouncement(
  swap: ActiveSwap,
  myOrder: MyOrderRef,
  dependencies: AnnounceReconcileDependencies = defaultDependencies,
): Promise<void> {
  const bookId = myOrder.bookId ?? swap.bookId ?? "primary";
  const order = await dependencies.getOrder(
    myOrder.id,
    myOrder.shareToken ?? undefined,
    bookId,
  );
  dependencies.assertMakerOrderProgress(myOrder, swap, order);
  if (order.status !== "accepted") return;
  const announced = await dependencies.announceHashlock(
    myOrder.id,
    {
      token: myOrder.token,
      hashlock: swap.hashlock ?? "",
      initiatorTimeout: swap.initiatorTimeout ?? 0,
      responderTimeout: swap.responderTimeout ?? 0,
    },
    bookId,
  );
  dependencies.assertMakerOrderProgress(myOrder, swap, announced);
}

/** Crash recovery for a maker whose tab died between persisting the swap
 *  (the preimage is saved first) and the hashlock reaching the order
 *  book: re-announce so the taker's client can proceed. Lives wherever
 *  the active swap is rendered after a reload; since active swaps now
 *  canonicalize to /swap/<hashlock>, that is the status route. Pass null
 *  when the rendered swap is not the caller's own. */
export function useAnnounceReconcile(swap: ActiveSwap | null): void {
  const reconciled = useRef(false);

  useEffect(() => {
    if (reconciled.current) return;
    if (!swap || swap.role !== "maker") return;
    if (!swap.hashlock || swap.initiatorTimeout === null || swap.responderTimeout === null) return;
    const myOrder = loadMyOrder();
    if (!myOrder || swap.orderId !== myOrder.id) return;
    reconciled.current = true;
    reconcileMakerAnnouncement(swap, myOrder)
      .then(() => {
        clearMyOrder();
      })
      .catch((err: unknown) => {
        if (err instanceof OrderGoneError) clearMyOrder();
        else reconciled.current = false; // transient; retry on next render
      });
  }, [swap]);
}
