import { useEffect, useState } from "react";
import { CLAIM_MARGIN_S } from "@/config";
import { saveActiveSwap, type ActiveSwap } from "@/lib/activeSwap";
import { getOrder, OrderGoneError } from "@/lib/orderbook";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/UI/Card";
import { Button } from "@/components/UI/Button";

interface Props {
  swap: ActiveSwap;
  onReady: (swap: ActiveSwap) => void;
  onAbort: (reason: string | null) => void;
}

const HASHLOCK_RE = /^0x[0-9a-f]{64}$/;

/** Taker-side waiting room: the order is accepted, the maker has not yet
 *  announced the hashlock. Nothing is locked on either chain, so walking
 *  away here is always safe. */
export function AwaitHashlock({ swap, onReady, onAbort }: Props) {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (swap.orderId === null) {
      onAbort("swap record has no order id");
      return;
    }
    const orderId = swap.orderId;
    let stop = false;
    const poll = async () => {
      try {
        const order = await getOrder(orderId);
        if (stop) return;
        if (order.status === "cancelled") {
          onAbort("The maker cancelled the order before locking. Nothing was at risk.");
          return;
        }
        if (order.status !== "locking" || order.hashlock === null) return;
        const now = Math.floor(Date.now() / 1000);
        if (
          !HASHLOCK_RE.test(order.hashlock) ||
          order.initiatorTimeout === null ||
          order.responderTimeout === null ||
          order.responderTimeout <= now + 600 ||
          order.initiatorTimeout < order.responderTimeout + CLAIM_MARGIN_S
        ) {
          onAbort("The maker announced unsafe swap parameters. Nothing was at risk.");
          return;
        }
        const updated: ActiveSwap = {
          ...swap,
          hashlock: order.hashlock,
          initiatorTimeout: order.initiatorTimeout,
          responderTimeout: order.responderTimeout,
        };
        saveActiveSwap(updated);
        onReady(updated);
      } catch (err) {
        if (stop) return;
        if (err instanceof OrderGoneError) {
          onAbort("The order disappeared from the order book. Nothing was at risk.");
        } else {
          setError(err instanceof Error ? err.message : "order book unreachable");
        }
      }
    };
    void poll();
    const t = setInterval(() => void poll(), 4000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [swap, onReady, onAbort]);

  return (
    <Card className="border-l-2 border-l-blue-accent">
      <CardHeader className="pb-3">
        <CardTitle className="text-lg">Order taken</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Waiting for the maker to publish the hashlock and lock their leg. No funds move from
          your side until you verify their lock on-chain in the next step.
        </p>
        {error ? <p className="text-sm text-amber-400">{error}</p> : null}
        <Button variant="outline" size="sm" onClick={() => onAbort(null)}>
          Walk away
        </Button>
      </CardContent>
    </Card>
  );
}
