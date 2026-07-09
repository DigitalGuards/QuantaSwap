// Exchange-style order book for the single QRL/ETH pair. Asks (makers
// selling ETH for QRL) stack above the spread, bids below, both with
// cumulative depth bars anchored right. Every row is one takeable
// protocol-mode order; clicking it starts the swap as taker.
//
// Color is polarity only (bid green / ask red, the exchange convention);
// the sides are also labeled and spatially split, so identity never
// rides on color alone. Depth fills are translucent 500-steps, text
// wears the 400-steps (WCAG-strong on the navy surface); the pair's CVD
// separation was validated (deutan dE 18+).

import { useCallback, useEffect, useMemo, useState } from "react";
import { formatEther } from "ethers";
import { saveActiveSwap, type ActiveSwap } from "@/lib/activeSwap";
import { acceptOrder, listOrders, type OrderView } from "@/lib/orderbook";
import { shortAddr } from "@/lib/htlc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/UI/Card";
import { cn } from "@/utils/cn";

interface Props {
  ethAccount: string | null;
  qrlAccount: string | null;
  /** The maker's own listing is shown in its own card, not here. */
  ownOrderId: string | null;
  /** Taking is disabled while you have an order or swap of your own. */
  takeDisabled: boolean;
  onTaken: (swap: ActiveSwap) => void;
}

interface BookRow {
  order: OrderView;
  /** QRL per ETH. */
  price: number;
  /** ETH changing hands. */
  amountEth: bigint;
  /** QRL changing hands. */
  totalQrl: bigint;
  /** Cumulative ETH from the best price outward, for the depth bar. */
  cumEth: bigint;
}

const fmtPrice = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const fmtAmount = (wei: bigint): string => {
  const s = formatEther(wei);
  return s.endsWith(".0") ? s.slice(0, -2) : s;
};

/** Price and sizes of one order, taker's perspective on the QRL/ETH pair. */
function toRow(order: OrderView): Omit<BookRow, "cumEth"> {
  const sellsEth = order.direction === "eth->qrl";
  const amountEth = BigInt(sellsEth ? order.fromAmount : order.toAmount);
  const totalQrl = BigInt(sellsEth ? order.toAmount : order.fromAmount);
  const price = Number(formatEther(totalQrl)) / Number(formatEther(amountEth));
  return { order, price, amountEth, totalQrl };
}

function cumulate(rows: Omit<BookRow, "cumEth">[]): BookRow[] {
  let cum = 0n;
  return rows.map((r) => {
    cum += r.amountEth;
    return { ...r, cumEth: cum };
  });
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

  const { asks, bids, maxCum, mid, spreadPct } = useMemo(() => {
    const visible = (orders ?? []).filter((o) => o.id !== ownOrderId);
    // Asks: makers selling ETH for QRL (taker pays QRL). Best = lowest price.
    const askRows = cumulate(
      visible.filter((o) => o.direction === "eth->qrl").map(toRow).sort((a, b) => a.price - b.price),
    );
    // Bids: makers buying ETH with QRL (taker pays ETH). Best = highest price.
    const bidRows = cumulate(
      visible.filter((o) => o.direction === "qrl->eth").map(toRow).sort((a, b) => b.price - a.price),
    );
    const top = [askRows.at(-1)?.cumEth ?? 0n, bidRows.at(-1)?.cumEth ?? 0n];
    const bestAsk = askRows[0]?.price;
    const bestBid = bidRows[0]?.price;
    const m = bestAsk !== undefined && bestBid !== undefined ? (bestAsk + bestBid) / 2 : (bestAsk ?? bestBid);
    const s = bestAsk !== undefined && bestBid !== undefined && m ? ((bestAsk - bestBid) / m) * 100 : null;
    return {
      asks: askRows,
      bids: bidRows,
      maxCum: top[0]! > top[1]! ? top[0]! : top[1]!,
      mid: m,
      spreadPct: s,
    };
  }, [orders, ownOrderId]);

  const canTake = Boolean(ethAccount && qrlAccount) && !takeDisabled && busyId === null;

  const Row = ({ row, side }: { row: BookRow; side: "ask" | "bid" }) => {
    const depth = maxCum > 0n ? Number((row.cumEth * 1000n) / maxCum) / 10 : 0;
    const give = side === "ask" ? "QRL" : "ETH";
    const get = side === "ask" ? "ETH" : "QRL";
    return (
      <button
        type="button"
        disabled={!canTake}
        onClick={() => take(row.order)}
        title={`Take: you send ${fmtAmount(side === "ask" ? row.totalQrl : row.amountEth)} ${give}, receive ${fmtAmount(side === "ask" ? row.amountEth : row.totalQrl)} ${get} · maker ${shortAddr(row.order.makerEthAccount)}`}
        className={cn(
          "relative grid w-full grid-cols-3 items-center gap-2 px-2 py-[5px] text-right font-mono text-xs",
          canTake ? "cursor-pointer hover:bg-muted/40" : "cursor-default",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "absolute inset-y-[1px] right-0 rounded-l-sm",
            side === "ask" ? "bg-red-500/10" : "bg-emerald-500/10",
          )}
          style={{ width: `${depth}%` }}
        />
        <span className={cn("relative text-left", side === "ask" ? "text-red-400" : "text-emerald-400")}>
          {busyId === row.order.id ? "taking…" : fmtPrice.format(row.price)}
        </span>
        <span className="relative text-foreground/90">{fmtAmount(row.amountEth)}</span>
        <span className="relative text-muted-foreground">{fmtAmount(row.totalQrl)}</span>
      </button>
    );
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg">Order book</CardTitle>
          <span className="text-xs text-muted-foreground">
            {orders === null ? "loading…" : `${asks.length + bids.length} open · QRL/ETH`}
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-0 px-3 pb-3">
        <div className="grid grid-cols-3 gap-2 px-2 pb-1.5 text-right text-[11px] text-muted-foreground">
          <span className="text-left">Price (QRL)</span>
          <span>Amount (ETH)</span>
          <span>Total (QRL)</span>
        </div>

        {asks.length === 0 && bids.length === 0 ? (
          <p className="px-2 py-3 text-sm text-muted-foreground">
            No open orders right now. Post one, or check back shortly.
          </p>
        ) : (
          <>
            <div className="flex flex-col-reverse">
              {/* best ask renders nearest the spread */}
              {asks.map((row) => (
                <Row key={row.order.id} row={row} side="ask" />
              ))}
            </div>
            {asks.length === 0 ? (
              <p className="px-2 py-1 text-center text-[11px] text-muted-foreground">no asks</p>
            ) : null}

            <div className="my-1 flex items-baseline justify-between border-y border-border/60 px-2 py-1.5">
              <span className="font-mono text-sm font-semibold">
                {mid !== undefined ? fmtPrice.format(mid) : "—"}
                <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">QRL/ETH mid</span>
              </span>
              <span className="text-[11px] text-muted-foreground">
                {spreadPct !== null ? `spread ${spreadPct.toFixed(2)}%` : "one-sided"}
              </span>
            </div>

            {bids.map((row) => (
              <Row key={row.order.id} row={row} side="bid" />
            ))}
            {bids.length === 0 ? (
              <p className="px-2 py-1 text-center text-[11px] text-muted-foreground">no bids</p>
            ) : null}
          </>
        )}

        <div className="space-y-1 px-2 pt-2">
          <p className="text-[11px] text-muted-foreground">
            <span className="text-red-400">asks</span>: buy ETH with QRL ·{" "}
            <span className="text-emerald-400">bids</span>: buy QRL with ETH · each row is one
            takeable order
          </p>
          {!ethAccount || !qrlAccount ? (
            <p className="text-xs text-muted-foreground">Connect both wallets to take an order.</p>
          ) : null}
          {takeDisabled ? (
            <p className="text-xs text-muted-foreground">
              Finish or cancel your own order before taking another.
            </p>
          ) : null}
          {error ? <p className="text-sm text-red-400">{error}</p> : null}
        </div>
      </CardContent>
    </Card>
  );
}
