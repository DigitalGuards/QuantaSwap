import { useEffect, useState } from "react";
import { Navigate, useLocation, useNavigate, useParams } from "react-router";
import { formatUnits } from "ethers";
import type { useEthWallet } from "@/hooks/useEthWallet";
import type { useQrlWallet } from "@/hooks/useQrlWallet";
import { ETH_ASSETS, QRL_LEG, ethAssetSymbolOrNull } from "@/config";
import type { ActiveSwap } from "@/lib/activeSwap";
import {
  acceptOrder,
  acceptedOrderTerms,
  getOrder,
  OrderGoneError,
  parseShareToken,
  releaseOrder,
  submitFillIntent,
  type OrderView,
} from "@/lib/orderbook";
import { shortAddr } from "@/lib/htlc";
import { prelockEscrowIssue } from "@/lib/prelock";
import {
  intentDigest,
  orderSigningSchemeForWallet,
  signFillIntentV1,
  verifyOrderV1Auth,
} from "@/lib/orderSigning";
import { generateSecret } from "@/lib/secrets";
import {
  buildSignedTakerSwap,
  sameSignedIntent,
} from "@/components/signedOrderFlow";
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
  const [proof, setProof] = useState<"checking" | "valid" | "invalid" | "legacy" | null>(
    null,
  );
  // On-chain check of a pre-funded order's escrow claim (the book cannot
  // prove funding; the hard gate stays the at-depth verification).
  const [escrow, setEscrow] = useState<{
    status: "checking" | "verified" | "unverified";
    issue: string | null;
  } | null>(null);

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

  const orderIsPrelocked = order?.prelocked === true && order.status === "open";
  const orderAssetRaw = order?.asset ?? "ETH";
  const orderProofKey =
    order === null
      ? null
      : JSON.stringify([
          order.id,
          order.direction,
          order.asset ?? "ETH",
          order.fromAmount,
          order.toAmount,
          order.makerEthAccount,
          order.makerQrlAccount,
          order.visibility ?? "public",
          order.allowedTakerEth ?? "",
          order.allowedTakerQrl ?? "",
          order.prelocked === true,
          order.hashlock,
          order.initiatorTimeout,
          order.makerAuth?.version,
          order.makerAuth?.scheme,
          order.makerAuth?.issuedAt,
          order.makerAuth?.expiresAt,
          order.makerAuth?.nonce,
          order.makerAuth?.signature,
          order.makerAuth?.publicKey,
          order.makerAuth?.descriptor,
        ]);
  useEffect(() => {
    if (!order) {
      setProof(null);
      return undefined;
    }
    if (order.makerAuth === undefined) {
      setProof("legacy");
      return undefined;
    }
    const target = order;
    let stale = false;
    setProof("checking");
    const timer = window.setTimeout(() => {
      const valid = verifyOrderV1Auth(target);
      if (!stale) setProof(valid ? "valid" : "invalid");
    }, 0);
    return () => {
      stale = true;
      window.clearTimeout(timer);
    };
    // Polling replaces the row object every five seconds. Re-check only if
    // signed OrderV1 material changed, so the proof badge does not flicker.
  }, [orderProofKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!order || !orderIsPrelocked) {
      setEscrow(null);
      return undefined;
    }
    const symbol = ethAssetSymbolOrNull(orderAssetRaw);
    if (symbol === null) return undefined;
    let stale = false;
    setEscrow({ status: "checking", issue: null });
    void prelockEscrowIssue(order, symbol)
      .then((issue) => {
        if (!stale) setEscrow({ status: "verified", issue });
      })
      .catch(() => {
        if (!stale) setEscrow({ status: "unverified", issue: null });
      });
    return () => {
      stale = true;
    };
    // Re-check when the order identity or its escrow anchors move, not on
    // every poll echo of the same object.
  }, [order?.id, orderIsPrelocked, order?.hashlock, orderAssetRaw]); // eslint-disable-line react-hooks/exhaustive-deps

  // An active swap always wins: the home route forwards to the waiting
  // room or the canonical /swap/<hashlock> flow.
  if (swap) return <Navigate to="/" replace />;

  const invalid = !id || !shareToken;
  const assetSymbol = order ? ethAssetSymbolOrNull(order.asset ?? "ETH") : null;
  const signingScheme = orderSigningSchemeForWallet(qrl.rdns);

  const take = () => {
    if (!order || !eth.account || !qrl.account || !shareToken || assetSymbol === null) return;
    const ethAccount = eth.account;
    const qrlAccount = qrl.account;
    setError(null);
    setBusy(true);
    if (order.makerAuth !== undefined) {
      let recovery: ActiveSwap | null = null;
      void (async () => {
        if (signingScheme === null || order.orderDigest === undefined) {
          throw new Error(
            "Portable orders require typed-data signing. Use MyQRLWallet Extension or the official QRL Web3 Wallet.",
          );
        }
        const releaseSecret = (await generateSecret()).preimage;
        const signed = await signFillIntentV1({
          body: {
            orderDigest: order.orderDigest,
            takerEthAccount: ethAccount,
            takerQrlAccount: qrlAccount,
          },
          order,
          releaseSecret,
          walletRdns: qrl.rdns,
          request: qrl.request,
        });
        const digest = intentDigest(signed.intent, signed.auth);
        recovery = buildSignedTakerSwap({
          order,
          asset: assetSymbol,
          accounts: {
            takerEthAccount: ethAccount,
            takerQrlAccount: qrlAccount,
          },
          signedIntent: signed,
          intentDigestHex: digest,
          releaseSecret,
          shareToken,
        });
        setSwap(recovery);
        const submitted = await submitFillIntent(
          order.id,
          signed,
          order.bookId,
          shareToken,
        );
        if (submitted.intentDigest !== digest || !sameSignedIntent(submitted, signed)) {
          throw new Error("The order book did not preserve the signed FillIntentV1 request.");
        }
      })()
        .then(() => {
          void navigate("/");
        })
        .catch((err: unknown) => {
          if (recovery !== null) {
            void navigate("/");
            return;
          }
          setError(err instanceof Error ? err.message : "Failed to request the order");
        })
        .finally(() => setBusy(false));
      return;
    }
    acceptOrder(order.id, {
      takerEthAccount: ethAccount,
      takerQrlAccount: qrlAccount,
      shareToken,
    })
      .then(({ order: accepted, takerToken }) => {
        // Accept-by-id returns the same order; still re-check the terms
        // before persisting what this client will escrow (the book's
        // response is untrusted, like everywhere else).
        let terms: ReturnType<typeof acceptedOrderTerms>;
        try {
          if (
            (accepted.makerAuth !== undefined && !verifyOrderV1Auth(accepted)) ||
            (order.makerAuth !== undefined && accepted.makerAuth === undefined)
          ) {
            throw new Error("The private order does not carry a valid maker signature.");
          }
          terms = acceptedOrderTerms(order, accepted, assetSymbol, "same-order", {
            takerEthAccount: ethAccount,
            takerQrlAccount: qrlAccount,
          });
        } catch (err) {
          // This endpoint reserved the id in the request, regardless of
          // what an untrusted response claims its id was.
          void releaseOrder(order.id, takerToken).catch(() => undefined);
          throw err;
        }
        const taken: ActiveSwap = {
          role: "taker",
          termsBindingVersion: 1,
          orderId: accepted.id,
          takerToken,
          shareToken,
          // Rendering hint only; fund-moving gates verify on-chain.
          ...(terms.prelocked ? { prelocked: true } : {}),
          acceptedPrelock: terms.prelocked
            ? { hashlock: terms.hashlock, initiatorTimeout: terms.initiatorTimeout }
            : null,
          direction: terms.direction,
          // The asset the taker agreed to is what this page displayed,
          // resolved against the local registry; on-chain token
          // verification runs against this, never the book's word.
          ethAsset: terms.asset,
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
      symbol: takerPaysEthLeg ? asset.symbol : QRL_LEG.display,
    };
    const recv = {
      amount: formatUnits(BigInt(order.fromAmount), takerPaysEthLeg ? 18 : asset.decimals),
      symbol: takerPaysEthLeg ? QRL_LEG.display : asset.symbol,
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
          {order.prelocked === true ? (
            <div className="flex justify-between">
              <span className="text-muted-foreground">Pre-funded escrow</span>
              <span
                className={
                  escrow === null || escrow.status === "checking"
                    ? "text-muted-foreground"
                    : escrow.issue !== null
                      ? "text-destructive"
                      : escrow.status === "unverified"
                        ? "text-amber-400"
                        : "text-success"
                }
              >
                {escrow === null || escrow.status === "checking"
                  ? "verifying…"
                  : escrow.issue !== null
                    ? "check failed"
                    : escrow.status === "unverified"
                      ? "unverified"
                      : "verified on-chain"}
              </span>
            </div>
          ) : null}
          <div className="flex justify-between">
            <span className="text-muted-foreground">Maker proof</span>
            <span
              className={
                proof === "valid"
                  ? "text-success"
                  : proof === "invalid"
                    ? "text-destructive"
                    : proof === "legacy"
                      ? "text-amber-400"
                      : "text-muted-foreground"
              }
            >
              {proof === "valid"
                ? "ML-DSA-87 verified"
                : proof === "invalid"
                  ? "invalid or expired"
                  : proof === "legacy"
                    ? "legacy unsigned"
                    : "verifying…"}
            </span>
          </div>
        </div>
        {order.prelocked === true && escrow?.issue ? (
          <p className="text-xs text-destructive">
            The escrow this order claims does not check out on-chain: {escrow.issue}. Do not take
            it; ask your counterparty to relist.
          </p>
        ) : null}
        {order.makerSeen === false ? (
          <p className="text-xs text-amber-400">
            The maker&apos;s wallet is not online right now. You can still take the order, but the
            swap only proceeds once they are back.
          </p>
        ) : null}
        <Button
          className="w-full"
          size="lg"
          disabled={
            !eth.account ||
            !qrl.account ||
            busy ||
            proof === "checking" ||
            proof === "invalid" ||
            (order.makerAuth !== undefined && signingScheme === null) ||
            (order.prelocked === true && escrow?.issue !== null && escrow?.issue !== undefined)
          }
          onClick={take}
        >
          {!eth.account || !qrl.account
            ? "Connect both wallets to take this swap"
            : busy
              ? order.makerAuth !== undefined
                ? "Requesting…"
                : "Taking…"
              : order.makerAuth !== undefined
                ? "Sign fill request"
                : "Take this swap"}
        </Button>
        {order.makerAuth !== undefined && signingScheme === null ? (
          <p className="text-xs text-amber-400">
            Install and connect MyQRLWallet Extension for the recommended portable-order flow.
            The official QRL Web3 Wallet is also compatible through qrl_signTypedData_v4.
          </p>
        ) : null}
        <p className="text-xs leading-relaxed text-muted-foreground">
          {order.makerAuth !== undefined
            ? "Your signed request holds no funds. The maker must publish a valid FillV1 before its response deadline; your browser verifies it before enabling any lock."
            : order.prelocked === true
              ? "Taking holds no funds yet: the maker's escrow is already on-chain, they assign you as its recipient, you verify that on-chain, then lock yours. The HTLCs settle the swap atomically or refund after the timelocks."
              : "Taking holds no funds yet: the maker locks first, you verify their lock on-chain, then lock yours. The HTLCs settle the swap atomically or refund after the timelocks."}
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
