import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatUnits } from "ethers";
import type { BrowserProvider } from "ethers";
import {
  ETH_ASSETS,
  INITIATOR_TIMEOUT_S,
  MIN_TAKEABLE_RUNWAY_S,
  QRL_LEG,
  RESPONDER_TIMEOUT_S,
} from "@/config";
import {
  clearActiveSwap,
  clearMyOrder,
  loadActiveSwap,
  saveActiveSwap,
  type ActiveSwap,
  type MyOrderRef,
} from "@/lib/activeSwap";
import { generateSecret } from "@/lib/secrets";
import { announceHashlock, getOrder, OrderGoneError, shareFragment, type OrderView } from "@/lib/orderbook";
import { cancelOrder, heartbeatOrder } from "@/lib/orderbook";
import { SwapStatus, buildReleaseData, getLegState } from "@/lib/htlc";
import { makeLegSender } from "@/lib/legSender";
import type { QrlTransport } from "@/hooks/useQrlWallet";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/UI/Card";
import { Button } from "@/components/UI/Button";
import { Input } from "@/components/UI/Input";

interface Props {
  myOrder: MyOrderRef;
  /** The maker's connected wallet accounts. The maker's own payout
   *  addresses are anchored to these, never to the order-book response, so
   *  a hostile book cannot redirect the maker's incoming leg (symmetric
   *  with the taker, whose addresses come from its wallet too). */
  ethAccount: string | null;
  qrlAccount: string | null;
  /** Wallet plumbing for the pre-funded escrow's release transaction. */
  browserProvider: BrowserProvider | null;
  ensureSepolia: () => Promise<void>;
  qrlRequest: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  qrlTransport: QrlTransport | null;
  onMatched: (swap: ActiveSwap) => void;
  onClosed: () => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The maker's listed order: waits for a taker, then generates the swap
 *  secret, announces the hashlock and hands over to the swap flow. The
 *  secret is persisted locally before the announcement so a mid-flight
 *  crash can never orphan locked funds. */
export function MyOrderCard({
  myOrder,
  ethAccount,
  qrlAccount,
  browserProvider,
  ensureSepolia,
  qrlRequest,
  qrlTransport,
  onMatched,
  onClosed,
}: Props) {
  const [order, setOrder] = useState<OrderView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  /** The listing is gone (cancelled or swept) but this is a pre-funded
   *  order: the escrow may still sit on-chain, so the handle must not be
   *  cleared until the funds are released. */
  const [orphaned, setOrphaned] = useState(false);
  const matching = useRef(false);

  const sendOnLeg = useMemo(
    () => makeLegSender({ browserProvider, ensureSepolia, qrlAccount, qrlTransport, qrlRequest }),
    [browserProvider, ensureSepolia, qrlAccount, qrlTransport, qrlRequest],
  );

  // Private orders live behind their share link; the maker's own reads
  // carry the token too (the listing 404s without it).
  const shareUrl =
    myOrder.shareToken === null
      ? null
      : `${window.location.origin}/o/${myOrder.id}${shareFragment(myOrder.shareToken)}`;

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
        } else if (myOrder.prelock !== null) {
          // Pre-funded order: the secret and T1 were fixed (and persisted)
          // before the escrow transaction; regenerating either would
          // desync us from the immutable on-chain lock. Only T2 is fresh:
          // the taker's window starts at match.
          const pre = myOrder.prelock;
          const now = Math.floor(Date.now() / 1000);
          if (pre.initiatorTimeout - now < MIN_TAKEABLE_RUNWAY_S) {
            throw new Error(
              "too little time remains on the pre-funded escrow to swap safely; release it and relist",
            );
          }
          swap = {
            role: "maker",
            orderId: current.id,
            takerToken: null,
            shareToken: myOrder.shareToken,
            direction: current.direction,
            ethAsset: myOrder.asset,
            fromAmount: myOrder.fromAmount ?? current.fromAmount,
            toAmount: myOrder.toAmount ?? current.toAmount,
            makerEthAccount: ethAccount,
            makerQrlAccount: qrlAccount,
            takerEthAccount: current.takerEthAccount,
            takerQrlAccount: current.takerQrlAccount,
            preimage: pre.preimage,
            hashlock: pre.hashlock,
            initiatorTimeout: pre.initiatorTimeout,
            responderTimeout: now + RESPONDER_TIMEOUT_S,
            prelocked: true,
            createdAt: now,
          };
          saveActiveSwap(swap);
        } else {
          const secret = await generateSecret();
          const now = Math.floor(Date.now() / 1000);
          swap = {
            role: "maker",
            orderId: current.id,
            takerToken: null,
            shareToken: myOrder.shareToken,
            direction: current.direction,
            // Anchored locally at post time, like the payout addresses:
            // the book's copy of the asset and amount fields is never
            // trusted (the book copy is only a fallback for handles
            // stored before amount anchoring existed).
            ethAsset: myOrder.asset,
            fromAmount: myOrder.fromAmount ?? current.fromAmount,
            toAmount: myOrder.toAmount ?? current.toAmount,
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
          const after = await getOrder(current.id, myOrder.shareToken ?? undefined);
          if (after.status === "open") {
            // The taker released before we announced; nothing published,
            // the listing is back on the book. Drop the provisional swap
            // record (its responder window would be stale by the time the
            // next taker arrives; nothing on-chain references it, and a
            // pre-funded order's secret lives in the order handle) and
            // keep waiting.
            clearActiveSwap();
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
    [myOrder.token, myOrder.asset, myOrder.fromAmount, myOrder.toAmount, myOrder.shareToken, ethAccount, qrlAccount, onMatched],
  );

  useEffect(() => {
    let stop = false;
    const poll = async () => {
      try {
        const current = await getOrder(myOrder.id, myOrder.shareToken ?? undefined);
        if (stop) return;
        setOrder(current);
        if (current.status === "accepted") void startSwap(current);
        if (current.status === "cancelled") {
          // A pre-funded handle must survive its listing: clearing it here
          // would delete the preimage while the escrow still sits on-chain.
          if (myOrder.prelock !== null) setOrphaned(true);
          else close();
        }
      } catch (err) {
        if (!stop && err instanceof OrderGoneError) {
          if (myOrder.prelock !== null) setOrphaned(true);
          else close();
        }
      }
    };
    void poll();
    const t = setInterval(() => void poll(), 4000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [myOrder.id, myOrder.shareToken, startSwap, close]);

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

  /** Pre-funded orders: pull the listing AND reclaim the escrow, clearing
   *  the local handle only once the funds have provably left the lock.
   *  Book cancel goes first so no taker reserves a dying listing; a
   *  racing accept is safe because release stays legal until assign. */
  const releaseEscrow = () => {
    const pre = myOrder.prelock;
    if (pre === null) return;
    setBusy(true);
    setError(null);
    void (async () => {
      // Best-effort delist. release() needs nothing from the book, so a
      // book outage (or a hostile 5xx) must not block the on-chain reclaim:
      // swallow every cancel error and proceed. A stale listing is harmless
      // (takers re-verify the escrow on-chain; a released lock can never be
      // assigned).
      await cancelOrder(myOrder.id, myOrder.token).catch(() => undefined);
      const state = await getLegState(pre.leg, pre.hashlock);
      if (state.status === SwapStatus.Open) {
        await sendOnLeg(pre.leg, buildReleaseData(pre.hashlock), 0n);
        for (let i = 0; ; i += 1) {
          const cur = await getLegState(pre.leg, pre.hashlock).catch(() => null);
          if (cur && cur.status !== SwapStatus.Open) break;
          if (i >= 39) throw new Error("release broadcast but not confirmed yet; retry shortly");
          await sleep(3000);
        }
      }
      close();
    })()
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Release failed");
      })
      .finally(() => setBusy(false));
  };

  // Amount formatting follows the order's ETH-leg asset (anchored locally
  // in myOrder.asset); the QRL side is always native 18-decimal QRL.
  const asset = ETH_ASSETS[myOrder.asset];
  const sideOf = (leg: "eth" | "qrl") =>
    leg === "eth"
      ? { symbol: asset.symbol, decimals: asset.decimals }
      : { symbol: QRL_LEG.asset, decimals: 18 };
  const fromSide = order ? sideOf(order.direction === "eth->qrl" ? "eth" : "qrl") : null;
  const toSide = order ? sideOf(order.direction === "eth->qrl" ? "qrl" : "eth") : null;

  return (
    <Card className="surface-ember">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg">Your open order</CardTitle>
          <span className="font-data text-xs text-muted-foreground">{myOrder.id}</span>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {order && fromSide && toSide ? (
          <p className="text-sm">
            Give <span className="font-data font-medium">{formatUnits(BigInt(order.fromAmount), fromSide.decimals)} {fromSide.symbol}</span>{" "}
            for <span className="font-data font-medium">{formatUnits(BigInt(order.toAmount), toSide.decimals)} {toSide.symbol}</span>
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">Loading order…</p>
        )}
        {orphaned ? (
          <div className="space-y-2 rounded-md border border-amber-400/40 bg-amber-400/10 p-3">
            <p className="text-xs leading-relaxed text-amber-400">
              The listing is gone from the book, but your pre-funded escrow may still sit
              on-chain. Release it to reclaim your funds; this handle keeps the swap secret until
              then.
            </p>
            <Button size="sm" variant="outline" disabled={busy} onClick={releaseEscrow}>
              {busy ? "Releasing…" : "Release escrow"}
            </Button>
          </div>
        ) : order?.status === "accepted" ? (
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
              {myOrder.prelock !== null
                ? shareUrl
                  ? "Private pre-funded order: hidden from the book, escrow already on-chain. When your counterparty accepts, you assign them with one transaction."
                  : "Listed pre-funded: your escrow is already on-chain. Keep this page open: when someone accepts, you assign them with one transaction."
                : shareUrl
                  ? "Private order: hidden from the book. Keep this page open: when your counterparty accepts, you lock first."
                  : "Listed on the order book, waiting for a taker. Keep this page open: when someone accepts, you lock first."}
            </span>
          </p>
        )}
        {shareUrl && order?.status === "open" ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Input
                readOnly
                value={shareUrl}
                onFocus={(e) => e.currentTarget.select()}
                aria-label="Private order share link"
                className="font-data h-8 text-xs"
              />
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  void navigator.clipboard.writeText(shareUrl).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  });
                }}
              >
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {order.allowedTakerEth || order.allowedTakerQrl
                ? "Anyone with this link can view the order, but only the reserved taker can accept it."
                : "Anyone with this link can take the order; share it only with your counterparty."}
            </p>
          </div>
        ) : null}
        {error ? (
          <div className="space-y-2">
            <p className="text-sm text-destructive">{error}</p>
            {order?.status === "accepted" ? (
              <div className="flex flex-wrap gap-2">
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
                {/* A prelocked match can wedge here (e.g. the runway floor
                    was crossed between accept and this poll, so startSwap
                    throws every time). Release stays legal until assign, so
                    give the maker the escape the error tells them to use
                    even though the accepted state hides the normal one. */}
                {myOrder.prelock !== null ? (
                  <Button size="sm" variant="outline" disabled={busy} onClick={releaseEscrow}>
                    Release escrow &amp; cancel
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
        {order?.status !== "accepted" && !orphaned ? (
          myOrder.prelock !== null ? (
            <Button variant="outline" size="sm" disabled={busy} onClick={releaseEscrow}>
              {busy ? "Releasing…" : "Release escrow & cancel"}
            </Button>
          ) : (
            <Button variant="outline" size="sm" disabled={busy} onClick={cancel}>
              Cancel order
            </Button>
          )
        ) : null}
      </CardContent>
    </Card>
  );
}
