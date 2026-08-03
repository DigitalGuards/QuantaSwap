import { useEffect, useRef } from "react";
import { clearMyOrder, loadMyOrder, type ActiveSwap } from "@/lib/activeSwap";
import { announceHashlock, getOrder, OrderGoneError } from "@/lib/orderbook";

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
    getOrder(myOrder.id, myOrder.shareToken ?? undefined)
      .then(async (order) => {
        if (order.status === "accepted") {
          await announceHashlock(myOrder.id, {
            token: myOrder.token,
            hashlock: swap.hashlock ?? "",
            initiatorTimeout: swap.initiatorTimeout ?? 0,
            responderTimeout: swap.responderTimeout ?? 0,
          });
        }
        clearMyOrder();
      })
      .catch((err: unknown) => {
        if (err instanceof OrderGoneError) clearMyOrder();
        else reconciled.current = false; // transient; retry on next render
      });
  }, [swap]);
}
