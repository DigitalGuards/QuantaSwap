// Exchange-style order book, one pair per tab: QRL as the BASE of every
// pair, priced in the ETH-leg quote asset (native ETH, USDC, tUSDT), per
// the usual BASE/QUOTE convention. Asks (makers selling QRL for the
// quote) stack above the spread, bids (makers buying QRL) below, both
// with cumulative QRL depth bars anchored right, scoped to the active
// pair.
// Every row is one takeable protocol-mode order; clicking it starts the
// swap as taker.
//
// Color is polarity only (bid green / ask red, the exchange convention);
// the sides are also labeled and spatially split, so identity never
// rides on color alone. Bids wear the theme's success token (~8:1 on the
// obsidian card); ask text wears red-400 (~6.9:1) because the destructive
// token (0 68% 46%) only reaches ~3.3:1 here and fails WCAG AA at this
// size, so it stays reserved for error copy. This mirrors the wallet's
// financial-polarity pairing (text-success with red-400/500). Depth
// fills stay translucent /10 token steps.

import { useCallback, useEffect, useMemo, useState } from "react";
import { formatUnits } from "ethers";
import {
  ETH_ASSETS,
  ETH_ASSET_SYMBOLS,
  QRL_LEG,
  type EthAsset,
  type EthAssetSymbol,
} from "@/config";
import { saveActiveSwap, type ActiveSwap } from "@/lib/activeSwap";
import { prelockEscrowIssue } from "@/lib/prelock";
import type { OrderDraft } from "@/components/PostOrderCard";
import {
  acceptOrder,
  acceptedOrderTerms,
  listOrders,
  openBookStream,
  releaseOrder,
  takeOrder,
  type OrderView,
} from "@/lib/orderbook";
import { shortAddr } from "@/lib/htlc";
import { verifyOrderV1Auth } from "@/lib/orderSigning";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/UI/Card";
import { Button } from "@/components/UI/Button";
import { cn } from "@/utils/cn";

interface Props {
  ethAccount: string | null;
  qrlAccount: string | null;
  /** The maker's own listing renders marked ("yours") and untakeable. */
  ownOrderId: string | null;
  /** Taking is disabled while you have an order or swap of your own. */
  takeDisabled: boolean;
  onTaken: (swap: ActiveSwap) => void;
  /** "Edit as my order": loads the clicked row's terms (viewer's
   *  perspective) into the post form instead of taking it. */
  onPrefill?: (draft: OrderDraft) => void;
}

interface BookRow {
  order: OrderView;
  /** Quote asset per 1 whole QRL (QRL is the base of every pair). */
  price: number;
  /** ETH-leg quote asset changing hands, in its base units. */
  amountUnits: bigint;
  /** QRL changing hands, wei. */
  totalQrl: bigint;
  /** Cumulative QRL wei from the best price outward, for the depth bar. */
  cumUnits: bigint;
}

// Price is in the quote asset per 1 QRL. Stable quotes read naturally at
// 2-4 decimals; an 18-decimal quote (ETH) needs more places (~0.00042650).
const fmtPrice = (price: number, quoteDecimals: number): string =>
  new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: quoteDecimals === 18 ? 8 : 4,
  }).format(price);

const fmtAmount = (units: bigint, decimals: number): string => {
  const s = formatUnits(units, decimals);
  return s.endsWith(".0") ? s.slice(0, -2) : s;
};

/** What taking this order costs the taker, in the taker's own terms: they
 *  send the maker's `toAmount` and receive the maker's `fromAmount`. */
function describeTake(
  order: OrderView,
  asset: EthAsset,
): {
  send: string;
  sendAsset: string;
  recv: string;
  recvAsset: string;
} {
  const sellsAsset = order.direction === "eth->qrl";
  return {
    send: fmtAmount(BigInt(order.toAmount), sellsAsset ? 18 : asset.decimals),
    sendAsset: sellsAsset ? QRL_LEG.display : asset.symbol,
    recv: fmtAmount(BigInt(order.fromAmount), sellsAsset ? asset.decimals : 18),
    recvAsset: sellsAsset ? asset.symbol : QRL_LEG.display,
  };
}

// Server cap rejections that mean "you cannot take more right now", as
// opposed to transient errors: surfaced as a blocking banner, not a small
// line, so a full book does not read as takeable when it is not.
const CAP_ERROR_RE = /take limit|swaps in progress/i;

/** Price and sizes of one order, taker's perspective on the active pair.
 *  QRL is the base of every pair, so price is quote-asset base units per
 *  one WHOLE QRL via bigint cross math (a float division of the raw
 *  strings would be off by 10^12 for 6-decimal assets), floated only at
 *  the end for display and sorting. */
function toRow(order: OrderView, asset: EthAsset): Omit<BookRow, "cumUnits"> {
  const sellsAsset = order.direction === "eth->qrl";
  const amountUnits = BigInt(sellsAsset ? order.fromAmount : order.toAmount);
  const totalQrl = BigInt(sellsAsset ? order.toAmount : order.fromAmount);
  const price =
    totalQrl === 0n
      ? 0
      : Number(formatUnits((amountUnits * 10n ** 18n) / totalQrl, asset.decimals));
  return { order, price, amountUnits, totalQrl };
}

// Depth accumulates in the base (QRL), the axis both sides share.
function cumulate(rows: Omit<BookRow, "cumUnits">[]): BookRow[] {
  let cum = 0n;
  return rows.map((r) => {
    cum += r.totalQrl;
    return { ...r, cumUnits: cum };
  });
}

export function OrderBookPanel({
  ethAccount,
  qrlAccount,
  ownOrderId,
  takeDisabled,
  onTaken,
  onPrefill,
}: Props) {
  const [orders, setOrders] = useState<OrderView[] | null>(null);
  const [pair, setPair] = useState<EthAssetSymbol>("ETH");
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // A row clicked but not yet confirmed. Taking reserves the order and
  // starts the maker locking, so it needs an explicit confirm, not a raw
  // click on browse.
  const [pending, setPending] = useState<OrderView | null>(null);
  const [proof, setProof] = useState<{
    id: string;
    status: "checking" | "valid" | "invalid" | "legacy";
  } | null>(null);
  // Set when the server refuses further takes (per-IP caps reached); blocks
  // the whole book until the caps free rather than 429-ing click by click.
  const [capBlocked, setCapBlocked] = useState(false);
  // On-chain check of a pending pre-funded order's escrow claim. The book
  // cannot prove funding; this reads the lock at the head before the taker
  // burns a take slot (the hard gate stays the at-depth verification).
  const [escrow, setEscrow] = useState<{
    id: string;
    status: "checking" | "verified" | "unverified";
    issue: string | null;
  } | null>(null);

  const asset = ETH_ASSETS[pair];

  useEffect(() => {
    if (!pending) {
      setProof(null);
      return undefined;
    }
    if (pending.makerAuth === undefined) {
      setProof({ id: pending.id, status: "legacy" });
      return undefined;
    }
    const target = pending;
    let stale = false;
    setProof({ id: target.id, status: "checking" });
    const timer = window.setTimeout(() => {
      const valid = verifyOrderV1Auth(target);
      if (!stale) setProof({ id: target.id, status: valid ? "valid" : "invalid" });
    }, 0);
    return () => {
      stale = true;
      window.clearTimeout(timer);
    };
  }, [pending]);

  useEffect(() => {
    if (!pending || pending.prelocked !== true) {
      setEscrow(null);
      return undefined;
    }
    const target = pending;
    let stale = false;
    setEscrow({ id: target.id, status: "checking", issue: null });
    void prelockEscrowIssue(target, pair)
      .then((issue) => {
        if (!stale) setEscrow({ id: target.id, status: "verified", issue });
      })
      .catch(() => {
        if (!stale) setEscrow({ id: target.id, status: "unverified", issue: null });
      });
    return () => {
      stale = true;
    };
  }, [pending, pair]);

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
    if (!ethAccount || !qrlAccount || order.id === ownOrderId) return;
    setError(null);
    setBusyId(order.id);
    const taker = { takerEthAccount: ethAccount, takerQrlAccount: qrlAccount };
    // Take by terms: if this exact row was just sniped, fill the next
    // order at the same terms or better instead of failing. The request
    // carries the active pair's asset so a QRL/USDC take can never fill a
    // QRL/ETH order whose raw amounts happen to satisfy the bounds.
    // Offline-maker rows are excluded from matching, so those go by
    // explicit id.
    const byId = order.makerSeen === false;
    const request =
      byId
        ? acceptOrder(order.id, taker)
        : takeOrder({
            direction: order.direction,
            asset: pair,
            maxPay: order.toAmount,
            minReceive: order.fromAmount,
            ...taker,
          });
    request
      .then(({ order: accepted, takerToken }) => {
        // Take-by-terms may legitimately fill a different row, but only
        // ever at the terms the user clicked or better. The response is
        // still the untrusted book's word, so re-check it before the
        // amounts are persisted as what this client will escrow and
        // verify against.
        let terms: ReturnType<typeof acceptedOrderTerms>;
        try {
          if (
            (accepted.makerAuth !== undefined && !verifyOrderV1Auth(accepted)) ||
            (order.makerAuth !== undefined && accepted.makerAuth === undefined)
          ) {
            throw new Error("The matched order does not carry a valid maker signature.");
          }
          terms = acceptedOrderTerms(
            order,
            accepted,
            pair,
            byId ? "same-order" : "same-or-better",
            taker,
          );
        } catch (err) {
          // Accept-by-id reserved the displayed id even if a hostile
          // response substituted another one. Take-by-terms legitimately
          // reserves the accepted id.
          const reservedId = byId ? order.id : accepted.id;
          void releaseOrder(reservedId, takerToken).catch(() => undefined);
          throw err;
        }
        const swap: ActiveSwap = {
          role: "taker",
          termsBindingVersion: 1,
          orderId: accepted.id,
          takerToken,
          shareToken: null,
          // Book's word only; the machine treats it as a rendering hint
          // (assign step instead of a lock step) and every fund-moving
          // gate still verifies the escrow on-chain at depth.
          ...(terms.prelocked ? { prelocked: true } : {}),
          acceptedPrelock: terms.prelocked
            ? { hashlock: terms.hashlock, initiatorTimeout: terms.initiatorTimeout }
            : null,
          direction: terms.direction,
          // The asset the taker agreed to is the displayed pair, anchored
          // client-side; on-chain token verification runs against this,
          // never against a book-provided value.
          ethAsset: pair,
          fromAmount: terms.fromAmount,
          toAmount: terms.toAmount,
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
    // Orders of other pairs (and of assets this build does not know) are
    // invisible here: unknown symbols match no tab, so they fail closed
    // out of the UI entirely. The caller's own order stays visible (a
    // hidden row reads as "my order vanished") but is marked and never
    // takeable.
    const visible = (orders ?? []).filter((o) => (o.asset ?? "ETH") === pair);
    // QRL is the base: asks are makers SELLING QRL for the quote asset
    // (direction qrl->eth), best = lowest quote price.
    const askRows = cumulate(
      visible
        .filter((o) => o.direction === "qrl->eth")
        .map((o) => toRow(o, asset))
        .sort((a, b) => a.price - b.price),
    );
    // Bids: makers BUYING QRL with the quote asset (direction eth->qrl),
    // best = highest quote price.
    const bidRows = cumulate(
      visible
        .filter((o) => o.direction === "eth->qrl")
        .map((o) => toRow(o, asset))
        .sort((a, b) => b.price - a.price),
    );
    const top = [askRows.at(-1)?.cumUnits ?? 0n, bidRows.at(-1)?.cumUnits ?? 0n];
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
  }, [orders, pair, asset]);

  const canTake =
    Boolean(ethAccount && qrlAccount) && !takeDisabled && !capBlocked && busyId === null;

  const Row = ({ row, side }: { row: BookRow; side: "ask" | "bid" }) => {
    const depth = maxCum > 0n ? Number((row.cumUnits * 1000n) / maxCum) / 10 : 0;
    // Taking an ask buys QRL: the taker sends the quote asset. Taking a
    // bid sells QRL: the taker sends QRL.
    const give = side === "ask" ? asset.symbol : QRL_LEG.display;
    const get = side === "ask" ? QRL_LEG.display : asset.symbol;
    const offline = row.order.makerSeen === false;
    const own = row.order.id === ownOrderId;
    // Selecting a row is harmless (it only opens the banner); wallet
    // and cap gating applies to the Confirm-take button, so the terms
    // stay inspectable and "Edit as my order" stays reachable.
    const selectable = !own && !takeDisabled;
    return (
      <button
        type="button"
        disabled={!selectable}
        onClick={() => setPending(row.order)}
        title={
          own
            ? "Your own order; manage it from your open-order card"
            : `Take: you send ${side === "ask" ? fmtAmount(row.amountUnits, asset.decimals) : fmtAmount(row.totalQrl, 18)} ${give}, receive ${side === "ask" ? fmtAmount(row.totalQrl, 18) : fmtAmount(row.amountUnits, asset.decimals)} ${get} · maker ${shortAddr(row.order.makerEthAccount)}${offline ? " · maker offline right now, the swap may not start" : ""}`
        }
        className={cn(
          "font-data relative grid w-full grid-cols-3 items-center gap-2 px-2 py-[5px] text-right text-xs",
          selectable ? "cursor-pointer hover:bg-muted/40" : "cursor-default",
          pending?.id === row.order.id && "bg-muted/40 ring-1 ring-blue-accent/40",
          offline && !own && "opacity-40",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "absolute inset-y-[1px] right-0 rounded-l-sm",
            side === "ask" ? "bg-destructive/10" : "bg-success/10",
          )}
          style={{ width: `${depth}%` }}
        />
        <span className={cn("relative text-left", side === "ask" ? "text-red-400" : "text-success")}>
          {busyId === row.order.id ? "taking…" : fmtPrice(row.price, asset.decimals)}
          {own ? (
            <span className="ml-1.5 rounded-sm bg-blue-accent/15 px-1 py-px text-[10px] font-medium text-blue-accent">
              yours
            </span>
          ) : null}
          {row.order.prelocked === true ? (
            <span
              className="ml-1.5 rounded-sm bg-success/15 px-1 py-px text-[10px] font-medium text-success"
              title="The maker escrowed funds at post time; verified on-chain before you commit"
            >
              funded
            </span>
          ) : null}
          {row.order.makerAuth !== undefined ? (
            <span
              className="ml-1.5 rounded-sm bg-secondary/15 px-1 py-px text-[10px] font-medium text-secondary"
              title="Portable ML-DSA-87 maker proof attached; verified before take"
            >
              PQ proof
            </span>
          ) : null}
        </span>
        <span className="relative text-foreground/90">{fmtAmount(row.totalQrl, 18)}</span>
        <span className="relative text-muted-foreground">
          {fmtAmount(row.amountUnits, asset.decimals)}
        </span>
      </button>
    );
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg">Order book</CardTitle>
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {orders !== null ? (
              <span aria-hidden className="glow-dot h-1.5 w-1.5 rounded-full bg-current text-success" />
            ) : null}
            {orders === null ? "loading…" : `${asks.length + bids.length} open · QRL/${pair}`}
          </span>
        </div>
        <div className="flex gap-1 pt-1" role="tablist" aria-label="trading pair">
          {ETH_ASSET_SYMBOLS.map((s) => (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={pair === s}
              onClick={() => {
                setPair(s);
                setPending(null);
                setError(null);
              }}
              className={cn(
                "rounded-md px-2 py-1 text-xs font-medium",
                pair === s
                  ? "bg-muted/60 text-foreground"
                  : "text-muted-foreground hover:bg-muted/40",
              )}
            >
              QRL/{s}
            </button>
          ))}
        </div>
      </CardHeader>
      <CardContent className="space-y-0 px-3 pb-3">
        {capBlocked ? (
          <div className="mx-2 mb-2 rounded-md border border-amber-400/40 bg-amber-400/10 p-2.5 text-xs text-amber-400">
            You have reached the per-visitor take limit (4 swaps at once, 24 per day). Finish or
            let your current swaps expire before taking another.
          </div>
        ) : null}

        {pending ? (
          <div className="mx-2 mb-2 space-y-2 rounded-md border border-blue-accent/40 bg-blue-accent/10 p-3">
            {(() => {
              const t = describeTake(pending, asset);
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
            {pending.prelocked === true && escrow?.id === pending.id ? (
              escrow.status === "checking" ? (
                <p className="text-xs text-muted-foreground">
                  Verifying the pre-funded escrow on-chain…
                </p>
              ) : escrow.issue !== null ? (
                <p className="text-xs text-destructive">
                  Pre-funded escrow check failed: {escrow.issue}. Taking is blocked; the listing
                  is not what it claims.
                </p>
              ) : escrow.status === "unverified" ? (
                <p className="text-xs text-amber-400">
                  Could not verify the pre-funded escrow right now. You can still take: nothing
                  moves from your side before your client re-verifies it on-chain.
                </p>
              ) : (
                <p className="text-xs text-success">
                  Pre-funded escrow verified on-chain: the maker&apos;s funds are already locked.
                </p>
              )
            ) : null}
            {proof?.id === pending.id ? (
              proof.status === "checking" ? (
                <p className="text-xs text-muted-foreground">
                  Verifying the maker&apos;s ML-DSA-87 OrderV1 proof…
                </p>
              ) : proof.status === "invalid" ? (
                <p className="text-xs text-destructive">
                  The maker signature is invalid or expired. Taking is blocked.
                </p>
              ) : proof.status === "valid" ? (
                <p className="text-xs text-success">
                  Maker&apos;s portable OrderV1 signature verified in this browser.
                </p>
              ) : (
                <p className="text-xs text-amber-400">
                  Legacy local-liquidity order: no portable maker proof is attached.
                </p>
              )
            ) : null}
            <p className="text-xs text-muted-foreground">
              {pending.prelocked === true
                ? "Confirming reserves this order; the maker only assigns you as recipient. It counts toward your daily take allowance whether or not you complete it."
                : "Confirming reserves this order and the maker starts locking their leg. It counts toward your daily take allowance whether or not you complete it."}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                disabled={
                  !canTake ||
                  (pending.prelocked === true &&
                    escrow?.id === pending.id &&
                    escrow.issue !== null) ||
                  (proof?.id === pending.id &&
                    (proof.status === "checking" || proof.status === "invalid"))
                }
                onClick={confirmTake}
              >
                Confirm take
              </Button>
              {onPrefill ? (
                <Button
                  variant="outline"
                  size="sm"
                  title="Load these terms into the post form to tweak and list your own order"
                  onClick={() => {
                    // The viewer's perspective: they would give the
                    // order's toAmount side and want its fromAmount side,
                    // so their own listing is the mirror direction.
                    const sellsAsset = pending.direction === "eth->qrl";
                    onPrefill({
                      direction: sellsAsset ? "qrl->eth" : "eth->qrl",
                      asset: pair,
                      fromAmount: fmtAmount(BigInt(pending.toAmount), sellsAsset ? 18 : asset.decimals),
                      toAmount: fmtAmount(BigInt(pending.fromAmount), sellsAsset ? asset.decimals : 18),
                    });
                    setPending(null);
                  }}
                >
                  Edit as my order
                </Button>
              ) : null}
              <Button variant="outline" size="sm" onClick={() => setPending(null)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : null}

        <div className="grid grid-cols-3 gap-2 px-2 pb-1.5 text-right text-[11px] text-muted-foreground">
          <span className="text-left">Price ({pair})</span>
          <span>Amount (Quanta)</span>
          <span>Total ({pair})</span>
        </div>

        {asks.length === 0 && bids.length === 0 ? (
          <p className="px-2 py-3 text-sm text-muted-foreground">
            No open QRL/{pair} orders right now. Post one, or check back shortly.
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
              <span className="font-data text-sm font-semibold">
                {mid !== undefined ? fmtPrice(mid, asset.decimals) : "-"}
                <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">
                  QRL/{pair} mid
                </span>
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
            <span className="text-red-400">asks</span>: sell QRL for {pair} ·{" "}
            <span className="text-success">bids</span>: buy QRL with {pair} · each row is one
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
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>
      </CardContent>
    </Card>
  );
}
