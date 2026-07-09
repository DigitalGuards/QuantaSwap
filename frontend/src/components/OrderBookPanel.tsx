import { useCallback, useEffect, useState } from "react";
import { formatEther } from "ethers";
import { ArrowRight } from "lucide-react";
import { legByKey } from "@/config";
import {
  initiatorLeg,
  responderLeg,
  saveActiveSwap,
  type ActiveSwap,
} from "@/lib/activeSwap";
import { acceptOrder, listOrders, type OrderView } from "@/lib/orderbook";
import { shortAddr } from "@/lib/htlc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/UI/Card";
import { Button } from "@/components/UI/Button";

interface Props {
  ethAccount: string | null;
  qrlAccount: string | null;
  /** The maker's own listing is shown in its own card, not here. */
  ownOrderId: string | null;
  /** Taking is disabled while you have an order or swap of your own. */
  takeDisabled: boolean;
  onTaken: (swap: ActiveSwap) => void;
}

export function OrderBookPanel({ ethAccount, qrlAccount, ownOrderId, takeDisabled, onTaken }: Props) {
  const [orders, setOrders] = useState<OrderView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setOrders(await listOrders());
    } catch {
      // transient; next poll retries
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const take = (order: OrderView) => {
    if (!ethAccount || !qrlAccount) return;
    setError(null);
    setBusyId(order.id);
    acceptOrder(order.id, { takerEthAccount: ethAccount, takerQrlAccount: qrlAccount })
      .then((accepted) => {
        const swap: ActiveSwap = {
          role: "taker",
          orderId: accepted.id,
          direction: accepted.direction,
          fromAmount: accepted.fromAmount,
          toAmount: accepted.toAmount,
          makerEthAccount: accepted.makerEthAccount,
          makerQrlAccount: accepted.makerQrlAccount,
          takerEthAccount: ethAccount,
          takerQrlAccount: qrlAccount,
          preimage: null,
          hashlock: null,
          initiatorTimeout: null,
          responderTimeout: null,
          createdAt: Math.floor(Date.now() / 1000),
        };
        saveActiveSwap(swap);
        onTaken(swap);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Failed to take the order");
        void refresh();
      })
      .finally(() => setBusyId(null));
  };

  const visible = (orders ?? []).filter((o) => o.id !== ownOrderId);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg">Order book</CardTitle>
          <span className="text-xs text-muted-foreground">
            {orders === null ? "loading…" : `${visible.length} open`}
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {visible.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No open orders right now. Post one above, or check back shortly.
          </p>
        ) : (
          visible.map((order) => {
            const give = legByKey(initiatorLeg(order.direction));
            const want = legByKey(responderLeg(order.direction));
            return (
              <div
                key={order.id}
                className="flex items-center justify-between gap-3 rounded-md border border-border/60 bg-muted/20 p-3"
              >
                <div className="min-w-0">
                  <p className="flex items-center gap-1.5 text-sm">
                    <span className="font-medium">
                      {formatEther(BigInt(order.fromAmount))} {give.asset}
                    </span>
                    <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="font-medium">
                      {formatEther(BigInt(order.toAmount))} {want.asset}
                    </span>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    maker {shortAddr(order.makerEthAccount)} · you send {want.asset}, receive{" "}
                    {give.asset}
                  </p>
                </div>
                <Button
                  size="sm"
                  disabled={takeDisabled || !ethAccount || !qrlAccount || busyId !== null}
                  onClick={() => take(order)}
                >
                  {busyId === order.id ? "Taking…" : "Take"}
                </Button>
              </div>
            );
          })
        )}
        {!ethAccount || !qrlAccount ? (
          <p className="text-xs text-muted-foreground">Connect both wallets to take an order.</p>
        ) : null}
        {takeDisabled ? (
          <p className="text-xs text-muted-foreground">
            Finish or cancel your own order before taking another.
          </p>
        ) : null}
        {error ? <p className="text-sm text-red-400">{error}</p> : null}
      </CardContent>
    </Card>
  );
}
