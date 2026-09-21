import { useEffect, useState } from "react";
import { formatUnits } from "ethers";
import { ETH_ASSETS, QRL_LEG } from "@/config";
import { saveActiveSwap, type ActiveSwap } from "@/lib/activeSwap";
import {
  announcedOrderTerms,
  getOrder,
  OrderGoneError,
  submitFillIntent,
} from "@/lib/orderbook";
import {
  sameSignedIntent,
  verifyTakerFill,
} from "@/components/signedOrderFlow";
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
        const now = Math.floor(Date.now() / 1000);
        if (
          swap.intent !== undefined &&
          swap.intentDigest !== undefined &&
          now < swap.intent.auth.expiresAt
        ) {
          try {
            const replayed = await submitFillIntent(
              orderId,
              swap.intent,
              swap.bookId,
              swap.shareToken ?? undefined,
            );
            if (
              replayed.intentDigest !== swap.intentDigest ||
              !sameSignedIntent(replayed, swap.intent)
            ) {
              throw new Error("The order book changed the saved FillIntentV1 replay.");
            }
            if (!stop) setError(null);
          } catch (err) {
            if (!stop) {
              setError(
                err instanceof Error ? err.message : "Could not replay the fill request",
              );
            }
          }
        }
        const order = await getOrder(
          orderId,
          swap.shareToken ?? undefined,
          swap.bookId,
        );
        if (stop) return;
        if (order.status === "cancelled") {
          onAbort("The maker cancelled the order before locking. Nothing was at risk.");
          return;
        }
        const signedRecovery =
          swap.orderDigest !== undefined &&
          swap.intent !== undefined &&
          swap.intentDigest !== undefined
            ? {
                orderDigest: swap.orderDigest,
                intent: swap.intent,
                intentDigest: swap.intentDigest,
              }
            : null;
        if (signedRecovery !== null) {
          if (
            order.status === "open" &&
            now > signedRecovery.intent.auth.expiresAt + 10
          ) {
            onAbort("The signed fill request expired before the maker selected it.");
            return;
          }
          try {
            const verified = verifyTakerFill(order, signedRecovery, { now });
            if (verified === null) {
              if (order.status === "locking") {
                onAbort("The order entered locking without a complete FillV1. Funding is blocked.");
              }
              return;
            }
            const updated: ActiveSwap = {
              ...swap,
              fill: verified.signed,
              fillDigest: verified.digest,
              hashlock: verified.signed.fill.hashlock,
              initiatorTimeout: verified.signed.fill.initiatorTimeout,
              responderTimeout: verified.signed.fill.responderTimeout,
            };
            saveActiveSwap(updated);
            onReady(updated);
          } catch (err) {
            onAbort(
              err instanceof Error
                ? err.message
                : "The maker FillV1 could not be verified. Funding is blocked.",
            );
          }
          return;
        }
        if (order.status !== "locking" || order.hashlock === null) return;
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
        <CardTitle className="text-lg">
          {swap.intent !== undefined ? "Fill request signed" : "Order taken"}
        </CardTitle>
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
          {swap.intent !== undefined
            ? "Waiting for the maker to select a request and publish FillV1. This browser verifies the maker signature, exact request, hashlock, timelocks, and response deadline before funding is enabled."
            : "Waiting for the maker to publish the hashlock and lock their leg. No funds move from your side until you verify their lock on-chain in the next step."}
        </p>
        {error ? <p className="text-sm text-amber-400">{error}</p> : null}
        <Button variant="outline" size="sm" onClick={() => onAbort(null)}>
          Walk away
        </Button>
        <p className="text-xs text-muted-foreground">
          {swap.intent !== undefined
            ? "Walking away publishes the release secret for this request or terminal fill. A signed OrderV1 never reopens; the maker can publish a fresh order."
            : "Walking away returns this order to the book. If the maker locks in the same moment, it still counts as one of your daily takes."}
        </p>
      </CardContent>
    </Card>
  );
}
