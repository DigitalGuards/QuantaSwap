import { useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import type { useEthWallet } from "@/hooks/useEthWallet";
import type { useQrlWallet } from "@/hooks/useQrlWallet";
import { loadMyOrder, type ActiveSwap, type MyOrderRef } from "@/lib/activeSwap";
import { releaseTake } from "@/lib/orderbook";
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
  const navigate = useNavigate();

  // An active swap's canonical URL is /swap/<hashlock>: bookmarkable,
  // shareable, and recorded in browser history. The interactive flow (and
  // the maker announce-reconcile) lives on that route now; only a taker
  // still waiting for the maker's hashlock stays here, since there is no
  // hash to link yet.
  if (swap && swap.hashlock) {
    return <Navigate to={`/swap/${swap.hashlock}`} replace />;
  }

  return (
    <div className="page-enter space-y-10 pb-16">
      <section className="relative pt-10 pb-2 text-center">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 -top-16 h-64 bg-[radial-gradient(ellipse_at_top,hsl(var(--secondary)/0.10),transparent_65%)]"
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
            {eth.error ? <p className="text-sm text-destructive">{eth.error}</p> : null}
            {qrl.error ? <p className="text-sm text-destructive">{qrl.error}</p> : null}
            {notice ? (
              <p className="rounded-md border border-border/60 bg-muted/20 p-3 text-sm text-muted-foreground">
                {notice}
              </p>
            ) : null}
          </div>
        ) : null}

        {swap ? (
          <div className="space-y-4">
            {swap.role === "taker" ? (
              <AwaitHashlock
                swap={swap}
                onReady={(updated) => {
                  setNotice(null);
                  setSwap(updated);
                  if (updated.hashlock) navigate(`/swap/${updated.hashlock}`);
                }}
                onAbort={(reason) => {
                  releaseTake(swap);
                  setNotice(reason);
                  setSwap(null);
                }}
              />
            ) : null}
            <NetworkPanel />
          </div>
        ) : (
          <div className="space-y-4 lg:grid lg:grid-cols-2 lg:items-start lg:gap-6 lg:space-y-0">
            {myOrder ? (
              <MyOrderCard
                myOrder={myOrder}
                ethAccount={eth.account}
                qrlAccount={qrl.account}
                onMatched={(matched) => {
                  setMyOrder(null);
                  setSwap(matched);
                  if (matched.hashlock) navigate(`/swap/${matched.hashlock}`);
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
