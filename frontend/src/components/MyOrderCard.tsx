import { useCallback, useEffect, useRef, useState } from "react";
import { formatEther } from "ethers";
import { INITIATOR_TIMEOUT_S, RESPONDER_TIMEOUT_S, legByKey } from "@/config";
import {
  clearMyOrder,
  initiatorLeg,
  loadActiveSwap,
  responderLeg,
  saveActiveSwap,
  type ActiveSwap,
  type MyOrderRef,
} from "@/lib/activeSwap";
import { generateSecret } from "@/lib/secrets";
import { announceHashlock, getOrder, OrderGoneError, type OrderView } from "@/lib/orderbook";
import { cancelOrder, heartbeatOrder } from "@/lib/orderbook";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/UI/Card";
import { Button } from "@/components/UI/Button";

interface Props {
  myOrder: MyOrderRef;
  /** The maker's connected wallet accounts. The maker's own payout
   *  addresses are anchored to these, never to the order-book response, so
   *  a hostile book cannot redirect the maker's incoming leg (symmetric
   *  with the taker, whose addresses come from its wallet too). */
  ethAccount: string | null;
  qrlAccount: string | null;
  onMatched: (swap: ActiveSwap) => void;
  onClosed: () => void;
}

/** The maker's listed order: waits for a taker, then generates the swap
 *  secret, announces the hashlock and hands over to the swap flow. The
 *  secret is persisted locally before the announcement so a mid-flight
 *  crash can never orphan locked funds. */
export function MyOrderCard({ myOrder, ethAccount, qrlAccount, onMatched, onClosed }: Props) {
  const [order, setOrder] = useState<OrderView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const matching = useRef(false);

  const close = useCallback(() => {
    clearMyOrder();
    onClosed();
  }, [onClosed]);

  const startSwap = useCallback(
    async (current: OrderView) => {
      if (matching.current) return;
      matching.current = true;
      setBusy(true);
      setError(null);
      try {
        if (!current.takerEthAccount || !current.takerQrlAccount) {
          throw new Error("taker addresses missing from the accepted order");
        }
        // Anchor our own payout addresses to the connected wallet, not the
        // book. The book is untrusted; using its value would let it feed us
        // an attacker address that our own secret-reveal gate then verifies
        // against, sending our incoming leg to the attacker.
        if (!ethAccount || !qrlAccount) {
          throw new Error("connect both wallets to start the swap");
        }
        // Reuse a previously generated secret for this order (retry after a
        // lost announce response); generating a fresh one would desync us
        // from whatever the order book already published.
        const stored = loadActiveSwap();
        let swap: ActiveSwap;
        if (stored && stored.role === "maker" && stored.orderId === current.id && stored.hashlock) {
          swap = stored;
        } else {
          const secret = await generateSecret();
          const now = Math.floor(Date.now() / 1000);
          swap = {
            role: "maker",
            orderId: current.id,
            takerToken: null,
            direction: current.direction,
            fromAmount: current.fromAmount,
            toAmount: current.toAmount,
            makerEthAccount: ethAccount,
            makerQrlAccount: qrlAccount,
            takerEthAccount: current.takerEthAccount,
            takerQrlAccount: current.takerQrlAccount,
            preimage: secret.preimage,
            hashlock: secret.hashlock,
            initiatorTimeout: now + INITIATOR_TIMEOUT_S,
            responderTimeout: now + RESPONDER_TIMEOUT_S,
            createdAt: now,
          };
          saveActiveSwap(swap);
        }
        let announced: OrderView;
        try {
          announced = await announceHashlock(current.id, {
            token: myOrder.token,
            hashlock: swap.hashlock ?? "",
            initiatorTimeout: swap.initiatorTimeout ?? 0,
            responderTimeout: swap.responderTimeout ?? 0,
          });
        } catch (err) {
          // The announce may have applied even though we saw an error
          // (lost response, or a 409 on retry). Converge via the book.
          const after = await getOrder(current.id);
          if (after.status === "open") {
            // The taker released before we announced; nothing published,
            // the listing is back on the book. Keep waiting.
            matching.current = false;
            return;
          }
          if (!(after.status === "locking" && after.hashlock === swap.hashlock)) throw err;
          announced = after;
        }
        // The taker pairing is only frozen once the order is locking; a
        // release + re-accept between our poll and the announce could have
        // swapped takers, so the announce response is the authority.
        if (announced.takerEthAccount && announced.takerQrlAccount) {
          swap = {
            ...swap,
            takerEthAccount: announced.takerEthAccount,
            takerQrlAccount: announced.takerQrlAccount,
          };
          saveActiveSwap(swap);
        }
        clearMyOrder();
        onMatched(swap);
      } catch (err) {
        matching.current = false;
        setError(err instanceof Error ? err.message : "Failed to start the swap");
      } finally {
        setBusy(false);
      }
    },
    [myOrder.token, ethAccount, qrlAccount, onMatched],
  );

  useEffect(() => {
    let stop = false;
    const poll = async () => {
      try {
        const current = await getOrder(myOrder.id);
        if (stop) return;
        setOrder(current);
        if (current.status === "accepted") void startSwap(current);
        if (current.status === "cancelled") close();
      } catch (err) {
        if (!stop && err instanceof OrderGoneError) close();
      }
    };
    void poll();
    const t = setInterval(() => void poll(), 4000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [myOrder.id, startSwap, close]);

  // Maker liveness: while this card is mounted the listing stays in the
  // takeable set; a closed tab ages out after the book's presence TTL, so
  // takers stop reserving orders whose maker cannot respond.
  useEffect(() => {
    const beat = () => void heartbeatOrder(myOrder.id, myOrder.token).catch(() => undefined);
    beat();
    const t = setInterval(beat, 30_000);
    return () => clearInterval(t);
  }, [myOrder.id, myOrder.token]);

  const cancel = () => {
    setBusy(true);
    setError(null);
    cancelOrder(myOrder.id, myOrder.token)
      .then(close)
      .catch((err: unknown) => {
        if (err instanceof OrderGoneError) {
          close();
          return;
        }
        setError(err instanceof Error ? err.message : "Cancel failed");
      })
      .finally(() => setBusy(false));
  };

  const fromLeg = order ? legByKey(initiatorLeg(order.direction)) : null;
  const toLeg = order ? legByKey(responderLeg(order.direction)) : null;

  return (
    <Card className="surface-ember">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg">Your open order</CardTitle>
          <span className="font-data text-xs text-muted-foreground">{myOrder.id}</span>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {order && fromLeg && toLeg ? (
          <p className="text-sm">
            Give <span className="font-data font-medium">{formatEther(BigInt(order.fromAmount))} {fromLeg.asset}</span>{" "}
            for <span className="font-data font-medium">{formatEther(BigInt(order.toAmount))} {toLeg.asset}</span>
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">Loading order…</p>
        )}
        {order?.status === "accepted" ? (
          <p className="text-sm text-blue-accent">
            {busy ? "Taker found: preparing the swap…" : "Taker found."}
          </p>
        ) : (
          <p className="flex items-start gap-2 text-sm text-muted-foreground">
            <span
              aria-hidden
              className="glow-dot mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-current text-success"
            />
            <span>
              Listed on the order book, waiting for a taker. Keep this page open: when someone
              accepts, you lock first.
            </span>
          </p>
        )}
        {error ? (
          <div className="space-y-2">
            <p className="text-sm text-destructive">{error}</p>
            {order?.status === "accepted" ? (
              <Button
                size="sm"
                disabled={busy}
                onClick={() => {
                  matching.current = false;
                  void startSwap(order);
                }}
              >
                Retry
              </Button>
            ) : null}
          </div>
        ) : null}
        {order?.status !== "accepted" ? (
          <Button variant="outline" size="sm" disabled={busy} onClick={cancel}>
            Cancel order
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}
