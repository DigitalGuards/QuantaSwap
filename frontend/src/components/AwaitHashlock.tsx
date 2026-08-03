import { useEffect, useState } from "react";
import { formatUnits } from "ethers";
import { ETH_ASSETS, QRL_LEG } from "@/config";
import { saveActiveSwap, type ActiveSwap } from "@/lib/activeSwap";
import { announcedOrderTerms, getOrder, OrderGoneError } from "@/lib/orderbook";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/UI/Card";
import { Button } from "@/components/UI/Button";

interface Props {
  swap: ActiveSwap;
  onReady: (swap: ActiveSwap) => void;
  onAbort: (reason: string | null) => void;
}

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
        const order = await getOrder(orderId, swap.shareToken ?? undefined);
        if (stop) return;
        if (order.status === "cancelled") {
          onAbort("The maker cancelled the order before locking. Nothing was at risk.");
          return;
        }
        if (order.status !== "locking" || order.hashlock === null) return;
        const now = Math.floor(Date.now() / 1000);
        let announced: ReturnType<typeof announcedOrderTerms>;
        try {
          announced = announcedOrderTerms(swap, order, now);
        } catch {
          onAbort("The maker announced unsafe swap parameters. Nothing was at risk.");
          return;
        }
        const updated: ActiveSwap = {
          ...swap,
          hashlock: announced.hashlock,
          initiatorTimeout: announced.initiatorTimeout,
          responderTimeout: announced.responderTimeout,
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

  // The taker sends the responder leg (toAmount) and receives the
  // initiator leg (fromAmount); amounts format with the order's ETH-leg
  // asset (QRL is always native, 18 decimals).
  const asset = ETH_ASSETS[swap.ethAsset];
  const sellsAsset = swap.direction === "eth->qrl";
  const send = {
    amount: formatUnits(BigInt(swap.toAmount), sellsAsset ? 18 : asset.decimals),
    symbol: sellsAsset ? QRL_LEG.display : asset.symbol,
  };
  const recv = {
    amount: formatUnits(BigInt(swap.fromAmount), sellsAsset ? asset.decimals : 18),
    symbol: sellsAsset ? asset.symbol : QRL_LEG.display,
  };

  return (
    <Card className="surface-ember">
      <CardHeader className="pb-3">
        <CardTitle className="text-lg">Order taken</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm">
          You send{" "}
          <span className="font-data font-medium">
            {send.amount} {send.symbol}
          </span>{" "}
          and receive{" "}
          <span className="font-data font-medium">
            {recv.amount} {recv.symbol}
          </span>
          .
        </p>
        <p className="text-sm text-muted-foreground">
          Waiting for the maker to publish the hashlock and lock their leg. No funds move from
          your side until you verify their lock on-chain in the next step.
        </p>
        {error ? <p className="text-sm text-amber-400">{error}</p> : null}
        <Button variant="outline" size="sm" onClick={() => onAbort(null)}>
          Walk away
        </Button>
        <p className="text-xs text-muted-foreground">
          Walking away returns this order to the book. If the maker locks in the same moment, it
          still counts as one of your daily takes.
        </p>
      </CardContent>
    </Card>
  );
}
