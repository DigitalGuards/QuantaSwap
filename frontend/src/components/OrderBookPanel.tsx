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
import {
  acceptOrder,
  listOrders,
  openBookStream,
  takeOrder,
  type OrderView,
} from "@/lib/orderbook";
import { shortAddr } from "@/lib/htlc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/UI/Card";
import { Button } from "@/components/UI/Button";
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

/** What taking this order costs the taker, in the taker's own terms: they
 *  send the maker's `toAmount` and receive the maker's `fromAmount`. */
function describeTake(order: OrderView): {
  send: string;
  sendAsset: string;
  recv: string;
  recvAsset: string;
} {
  const sellsEth = order.direction === "eth->qrl";
  return {
    send: fmtAmount(BigInt(order.toAmount)),
    sendAsset: sellsEth ? "QRL" : "ETH",
    recv: fmtAmount(BigInt(order.fromAmount)),
    recvAsset: sellsEth ? "ETH" : "QRL",
  };
}

// Server cap rejections that mean "you cannot take more right now", as
// opposed to transient errors: surfaced as a blocking banner, not a small
// line, so a full book does not read as takeable when it is not.
const CAP_ERROR_RE = /take limit|swaps in progress/i;

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
  // A row clicked but not yet confirmed. Taking reserves the order and
  // starts the maker locking, so it needs an explicit confirm, not a raw
  // click on browse.
  const [pending, setPending] = useState<OrderView | null>(null);
  // Set when the server refuses further takes (per-IP caps reached); blocks
  // the whole book until the caps free rather than 429-ing click by click.
  const [capBlocked, setCapBlocked] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setOrders(await listOrders());
    } catch {
      // transient; next poll retries
    }
  }, []);

  // Live book via SSE, with the old poll demoted to a fallback that only
  // fires while the stream is down (blocked proxy, reconnect gap).
  useEffect(() => {
    void refresh();
    const stream = openBookStream(setOrders);
    const t = setInterval(() => {
      if (!stream.isLive()) void refresh();
    }, 5000);
    return () => {
      stream.close();
      clearInterval(t);
    };
  }, [refresh]);

  const take = (order: OrderView) => {
    if (!ethAccount || !qrlAccount) return;
    setError(null);
    setBusyId(order.id);
    const taker = { takerEthAccount: ethAccount, takerQrlAccount: qrlAccount };
    // Take by terms: if this exact row was just sniped, fill the next
    // order at the same terms or better instead of failing. Offline-maker
    // rows are excluded from matching, so those go by explicit id.
    const request =
      order.makerSeen === false
        ? acceptOrder(order.id, taker)
        : takeOrder({
            direction: order.direction,
            maxPay: order.toAmount,
            minReceive: order.fromAmount,
            ...taker,
          });
    request
      .then(({ order: accepted, takerToken }) => {
        const swap: ActiveSwap = {
          role: "taker",
          orderId: accepted.id,
          takerToken,
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
        const message = err instanceof Error ? err.message : "Failed to take the order";
        setError(message);
        if (CAP_ERROR_RE.test(message)) setCapBlocked(true);
        void refresh();
      })
      .finally(() => setBusyId(null));
  };

  const confirmTake = () => {
    if (!pending) return;
    const order = pending;
    setPending(null);
    take(order);
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

  const canTake =
    Boolean(ethAccount && qrlAccount) && !takeDisabled && !capBlocked && busyId === null;

  const Row = ({ row, side }: { row: BookRow; side: "ask" | "bid" }) => {
    const depth = maxCum > 0n ? Number((row.cumEth * 1000n) / maxCum) / 10 : 0;
    const give = side === "ask" ? "QRL" : "ETH";
    const get = side === "ask" ? "ETH" : "QRL";
    const offline = row.order.makerSeen === false;
    return (
      <button
        type="button"
        disabled={!canTake}
        onClick={() => setPending(row.order)}
        title={`Take: you send ${fmtAmount(side === "ask" ? row.totalQrl : row.amountEth)} ${give}, receive ${fmtAmount(side === "ask" ? row.amountEth : row.totalQrl)} ${get} · maker ${shortAddr(row.order.makerEthAccount)}${offline ? " · maker offline right now, the swap may not start" : ""}`}
        className={cn(
          "relative grid w-full grid-cols-3 items-center gap-2 px-2 py-[5px] text-right font-mono text-xs",
          canTake ? "cursor-pointer hover:bg-muted/40" : "cursor-default",
          pending?.id === row.order.id && "bg-muted/40 ring-1 ring-blue-accent/40",
          offline && "opacity-40",
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
        {capBlocked ? (
          <div className="mx-2 mb-2 rounded-md border border-amber-400/40 bg-amber-400/10 p-2.5 text-xs text-amber-400">
            You have reached the per-visitor take limit (2 swaps at once, 6 per day). Finish or let
            your current swaps expire before taking another.
          </div>
        ) : null}

        {pending ? (
          <div className="mx-2 mb-2 space-y-2 rounded-md border border-blue-accent/40 bg-blue-accent/10 p-3">
            {(() => {
              const t = describeTake(pending);
              return (
                <p className="text-sm">
                  Take this order: send{" "}
                  <span className="font-medium">
                    {t.send} {t.sendAsset}
                  </span>
                  , receive{" "}
                  <span className="font-medium">
                    {t.recv} {t.recvAsset}
                  </span>
                  .
                </p>
              );
            })()}
            <p className="text-xs text-muted-foreground">
              Confirming reserves this order and the maker starts locking their leg. It counts as one
              of your 6 takes per day whether or not you complete it.
            </p>
            <div className="flex gap-2">
              <Button size="sm" disabled={!canTake} onClick={confirmTake}>
                Confirm take
              </Button>
              <Button variant="outline" size="sm" onClick={() => setPending(null)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : null}

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
