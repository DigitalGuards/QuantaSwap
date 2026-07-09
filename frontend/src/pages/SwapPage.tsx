import { useEffect, useRef, useState } from "react";
import type { useEthWallet } from "@/hooks/useEthWallet";
import type { useQrlWallet } from "@/hooks/useQrlWallet";
import {
  clearMyOrder,
  loadMyOrder,
  type ActiveSwap,
  type MyOrderRef,
} from "@/lib/activeSwap";
import { announceHashlock, getOrder, OrderGoneError } from "@/lib/orderbook";
import { SwapFlow } from "@/components/SwapFlow";
import { PostOrderCard } from "@/components/PostOrderCard";
import { MyOrderCard } from "@/components/MyOrderCard";
import { OrderBookPanel } from "@/components/OrderBookPanel";
import { AwaitHashlock } from "@/components/AwaitHashlock";
import { NetworkPanel } from "@/components/NetworkPanel";

interface Props {
  eth: ReturnType<typeof useEthWallet>;
  qrl: ReturnType<typeof useQrlWallet>;
  swap: ActiveSwap | null;
  setSwap: (swap: ActiveSwap | null) => void;
}

export function SwapPage({ eth, qrl, swap, setSwap }: Props) {
  const [myOrder, setMyOrder] = useState<MyOrderRef | null>(() => loadMyOrder());
  const [notice, setNotice] = useState<string | null>(null);
  const reconciled = useRef(false);

  // Crash recovery: if a maker swap was persisted but the tab died before
  // the hashlock reached the order book, re-announce it so the taker's
  // client can proceed. The preimage was saved first, so nothing is lost.
  useEffect(() => {
    if (reconciled.current) return;
    if (!swap || swap.role !== "maker" || !myOrder || swap.orderId !== myOrder.id) return;
    if (!swap.hashlock || swap.initiatorTimeout === null || swap.responderTimeout === null) return;
    reconciled.current = true;
    const settle = () => {
      clearMyOrder();
      setMyOrder(null);
    };
    getOrder(myOrder.id)
      .then(async (order) => {
        if (order.status === "accepted") {
          await announceHashlock(myOrder.id, {
            token: myOrder.token,
            hashlock: swap.hashlock ?? "",
            initiatorTimeout: swap.initiatorTimeout ?? 0,
            responderTimeout: swap.responderTimeout ?? 0,
          });
        }
        settle();
      })
      .catch((err: unknown) => {
        if (err instanceof OrderGoneError) settle();
        else reconciled.current = false; // transient; retry on next render
      });
  }, [swap, myOrder]);

  return (
    <div className="space-y-10 pb-16">
      <section className="relative pt-10 pb-2 text-center">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 -top-16 h-64 bg-[radial-gradient(ellipse_at_top,hsl(25_95%_53%/0.10),transparent_65%)]"
        />
        <h1 className="text-3xl font-black tracking-tight md:text-5xl">
          Atomic swaps for <span className="text-secondary">QRL</span>
        </h1>
        <p className="mx-auto mt-4 max-w-xl text-muted-foreground">
          Swap between Ethereum and QRL with no custodian and no bridge. Post an order or take
          one; hashed timelock contracts on both chains settle every swap atomically or refund.
        </p>
      </section>

      <section className={swap ? "mx-auto max-w-md" : "mx-auto max-w-md lg:max-w-5xl"}>
        {eth.error || qrl.error || notice ? (
          <div className="mb-4 space-y-4">
            {eth.error ? <p className="text-sm text-red-400">{eth.error}</p> : null}
            {qrl.error ? <p className="text-sm text-red-400">{qrl.error}</p> : null}
            {notice ? (
              <p className="rounded-md border border-border/60 bg-muted/20 p-3 text-sm text-muted-foreground">
                {notice}
              </p>
            ) : null}
          </div>
        ) : null}

        {swap ? (
          <div className="space-y-4">
            {swap.role === "taker" && !swap.hashlock ? (
              <AwaitHashlock
                swap={swap}
                onReady={(updated) => {
                  setNotice(null);
                  setSwap(updated);
                }}
                onAbort={(reason) => {
                  setNotice(reason);
                  setSwap(null);
                }}
              />
            ) : (
              <SwapFlow
                swap={swap}
                ethAccount={eth.account}
                qrlAccount={qrl.account}
                browserProvider={eth.browserProvider}
                ensureSepolia={eth.ensureSepolia}
                qrlRequest={qrl.request}
                qrlTransport={qrl.kind}
                onDiscard={() => setSwap(null)}
              />
            )}
            <NetworkPanel />
          </div>
        ) : (
          <div className="space-y-4 lg:grid lg:grid-cols-2 lg:items-start lg:gap-6 lg:space-y-0">
            {myOrder ? (
              <MyOrderCard
                myOrder={myOrder}
                onMatched={(matched) => {
                  setMyOrder(null);
                  setSwap(matched);
                }}
                onClosed={() => setMyOrder(null)}
              />
            ) : (
              <PostOrderCard
                ethAccount={eth.account}
                qrlAccount={qrl.account}
                onPosted={setMyOrder}
              />
            )}
            <div className="space-y-4">
              <OrderBookPanel
                ethAccount={eth.account}
                qrlAccount={qrl.account}
                ownOrderId={myOrder?.id ?? null}
                takeDisabled={Boolean(myOrder)}
                onTaken={(taken) => {
                  setNotice(null);
                  setSwap(taken);
                }}
              />
              <NetworkPanel />
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
