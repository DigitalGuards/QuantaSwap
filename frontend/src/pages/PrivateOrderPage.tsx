import { useEffect, useState } from "react";
import { Navigate, useLocation, useNavigate, useParams } from "react-router-dom";
import { formatUnits } from "ethers";
import type { useEthWallet } from "@/hooks/useEthWallet";
import type { useQrlWallet } from "@/hooks/useQrlWallet";
import { ETH_ASSETS, QRL_LEG, ethAssetSymbolOrNull } from "@/config";
import type { ActiveSwap } from "@/lib/activeSwap";
import {
  acceptOrder,
  getOrder,
  OrderGoneError,
  parseShareToken,
  releaseOrder,
  type OrderView,
} from "@/lib/orderbook";
import { shortAddr } from "@/lib/htlc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/UI/Card";
import { Button } from "@/components/UI/Button";
import { NetworkPanel } from "@/components/NetworkPanel";

interface Props {
  eth: ReturnType<typeof useEthWallet>;
  qrl: ReturnType<typeof useQrlWallet>;
  swap: ActiveSwap | null;
  setSwap: (swap: ActiveSwap | null) => void;
}

/** Landing page for a private order's share link (/o/<id>#k=<token>).
 *  The token stays in the URL fragment (it never reaches any server log)
 *  and rides the X-Share-Token header on API reads. Taking the order is
 *  the ordinary accept-by-id flow; from there the standard swap flow
 *  (AwaitHashlock on /, then /swap/<hashlock>) takes over. */
export function PrivateOrderPage({ eth, qrl, swap, setSwap }: Props) {
  const { id } = useParams();
  const { hash } = useLocation();
  const navigate = useNavigate();
  const shareToken = parseShareToken(hash);

  const [order, setOrder] = useState<OrderView | null>(null);
  const [gone, setGone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!id || !shareToken) return;
    let stop = false;
    const poll = async () => {
      try {
        const current = await getOrder(id, shareToken);
        if (!stop) setOrder(current);
      } catch (err) {
        if (stop) return;
        if (err instanceof OrderGoneError) setGone(true);
        else setError(err instanceof Error ? err.message : "order book unreachable");
      }
    };
    void poll();
    const t = setInterval(() => void poll(), 5000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [id, shareToken]);

  // An active swap always wins: the home route forwards to the waiting
  // room or the canonical /swap/<hashlock> flow.
  if (swap) return <Navigate to="/" replace />;

  const invalid = !id || !shareToken;
  const assetSymbol = order ? ethAssetSymbolOrNull(order.asset ?? "ETH") : null;

  const take = () => {
    if (!order || !eth.account || !qrl.account || !shareToken || assetSymbol === null) return;
    const ethAccount = eth.account;
    const qrlAccount = qrl.account;
    setError(null);
    setBusy(true);
    acceptOrder(order.id, {
      takerEthAccount: ethAccount,
      takerQrlAccount: qrlAccount,
      shareToken,
    })
      .then(({ order: accepted, takerToken }) => {
        // Accept-by-id returns the same order; still re-check the terms
        // before persisting what this client will escrow (the book's
        // response is untrusted, like everywhere else).
        if (accepted.fromAmount !== order.fromAmount || accepted.toAmount !== order.toAmount) {
          void releaseOrder(accepted.id, takerToken).catch(() => undefined);
          throw new Error("The order book returned different terms than displayed; the take was abandoned.");
        }
        const taken: ActiveSwap = {
          role: "taker",
          orderId: accepted.id,
          takerToken,
          shareToken,
          direction: accepted.direction,
          // The asset the taker agreed to is what this page displayed,
          // resolved against the local registry; on-chain token
          // verification runs against this, never the book's word.
          ethAsset: assetSymbol,
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
        setSwap(taken);
        void navigate("/");
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Failed to take the order");
      })
      .finally(() => setBusy(false));
  };

  const body = () => {
    if (invalid || gone) {
      return (
        <p className="text-sm text-muted-foreground">
          This private order does not exist, was cancelled or taken, or the link is incomplete.
          Ask your counterparty for a fresh link.
        </p>
      );
    }
    if (!order) {
      return <p className="text-sm text-muted-foreground">Loading order…</p>;
    }
    if (assetSymbol === null) {
      return (
        <p className="text-sm text-destructive">
          This order trades an asset this build does not recognize; refusing to proceed.
        </p>
      );
    }
    if (order.status !== "open") {
      return (
        <p className="text-sm text-muted-foreground">
          This order is no longer open ({order.status}). Ask your counterparty to post a new one.
        </p>
      );
    }

    const asset = ETH_ASSETS[assetSymbol];
    // The taker pays the order's toAmount side and receives its
    // fromAmount side; the ETH-leg side formats with the order's asset,
    // the QRL side is always native 18-decimal QRL.
    const takerPaysEthLeg = order.direction === "qrl->eth";
    const pay = {
      amount: formatUnits(BigInt(order.toAmount), takerPaysEthLeg ? asset.decimals : 18),
      symbol: takerPaysEthLeg ? asset.symbol : QRL_LEG.asset,
    };
    const recv = {
      amount: formatUnits(BigInt(order.fromAmount), takerPaysEthLeg ? 18 : asset.decimals),
      symbol: takerPaysEthLeg ? QRL_LEG.asset : asset.symbol,
    };
    const reserved = order.allowedTakerEth ?? order.allowedTakerQrl;

    return (
      <div className="space-y-4">
        <p className="text-sm">
          You send{" "}
          <span className="font-data font-medium">
            {pay.amount} {pay.symbol}
          </span>{" "}
          and receive{" "}
          <span className="font-data font-medium">
            {recv.amount} {recv.symbol}
          </span>
          .
        </p>
        <div className="space-y-1.5 rounded-md border border-border/60 bg-muted/20 p-3 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Maker</span>
            <span className="font-data text-xs">
              {shortAddr(order.makerEthAccount)} / {shortAddr(order.makerQrlAccount)}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Maker online</span>
            <span className={order.makerSeen === false ? "text-amber-400" : "text-success"}>
              {order.makerSeen === false ? "offline" : "online"}
            </span>
          </div>
          {reserved ? (
            <div className="flex justify-between">
              <span className="text-muted-foreground">Reserved for</span>
              <span className="font-data text-xs">
                {[order.allowedTakerEth, order.allowedTakerQrl]
                  .filter((a): a is string => Boolean(a))
                  .map((a) => shortAddr(a))
                  .join(" / ")}
              </span>
            </div>
          ) : null}
        </div>
        {order.makerSeen === false ? (
          <p className="text-xs text-amber-400">
            The maker&apos;s wallet is not online right now. You can still take the order, but the
            swap only proceeds once they are back.
          </p>
        ) : null}
        <Button
          className="w-full"
          size="lg"
          disabled={!eth.account || !qrl.account || busy}
          onClick={take}
        >
          {!eth.account || !qrl.account
            ? "Connect both wallets to take this swap"
            : busy
              ? "Taking…"
              : "Take this swap"}
        </Button>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Taking holds no funds yet: the maker locks first, you verify their lock on-chain, then
          lock yours. The HTLCs settle the swap atomically or refund after the timelocks.
        </p>
      </div>
    );
  };

  return (
    <div className="page-enter mx-auto max-w-md space-y-4 pt-10 pb-16">
      <Card className="surface-ember">
        <CardHeader className="pb-3">
          <CardTitle className="text-lg">Private swap invitation</CardTitle>
        </CardHeader>
        <CardContent>
          {error ? <p className="mb-3 text-sm text-destructive">{error}</p> : null}
          {body()}
        </CardContent>
      </Card>
      <NetworkPanel />
    </div>
  );
}
