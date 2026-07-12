import { useState } from "react";
import { formatUnits, parseUnits } from "ethers";
import { ArrowDownUp, BookPlus } from "lucide-react";
import {
  ETH_ASSETS,
  ETH_ASSET_SYMBOLS,
  ETH_LEG,
  MIN_QRL_AMOUNT_WEI,
  QRL_LEG,
  ethAssetSymbolOrNull,
  type EthAssetSymbol,
} from "@/config";
import type { Direction } from "@/lib/activeSwap";
import { saveMyOrder, type MyOrderRef } from "@/lib/activeSwap";
import { createOrder } from "@/lib/orderbook";
import { shortAddr } from "@/lib/htlc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/UI/Card";
import { Button } from "@/components/UI/Button";
import { Input } from "@/components/UI/Input";

interface Props {
  ethAccount: string | null;
  qrlAccount: string | null;
  onPosted: (ref: MyOrderRef) => void;
}

const trimAmount = (units: bigint, decimals: number): string => {
  const s = formatUnits(units, decimals);
  return s.endsWith(".0") ? s.slice(0, -2) : s;
};

/** parseUnits with a friendly error instead of ethers' internal one when
 *  the input carries more fraction digits than the asset supports. */
const parseAmount = (value: string, decimals: number, symbol: string): bigint => {
  const fraction = value.split(".")[1];
  if (fraction !== undefined && fraction.length > decimals) {
    throw new Error(`${symbol} supports at most ${decimals} decimal places`);
  }
  return parseUnits(value, decimals);
};

const ETH_ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const QRL_ADDR_RE = /^Q[0-9a-fA-F]{40}$/;

export function PostOrderCard({ ethAccount, qrlAccount, onPosted }: Props) {
  const [direction, setDirection] = useState<Direction>("eth->qrl");
  const [assetSymbol, setAssetSymbol] = useState<EthAssetSymbol>("ETH");
  const [fromAmount, setFromAmount] = useState("");
  const [toAmount, setToAmount] = useState("");
  const [isPrivate, setIsPrivate] = useState(false);
  const [allowedEth, setAllowedEth] = useState("");
  const [allowedQrl, setAllowedQrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const asset = ETH_ASSETS[assetSymbol];
  // The ETH-leg side gives `asset`; the QRL side is always native QRL.
  const fromSymbol = direction === "eth->qrl" ? asset.symbol : QRL_LEG.asset;
  const toSymbol = direction === "eth->qrl" ? QRL_LEG.asset : asset.symbol;

  const ready = Boolean(ethAccount && qrlAccount && Number(fromAmount) > 0 && Number(toAmount) > 0);

  const post = async () => {
    if (!ethAccount || !qrlAccount) return;
    setError(null);
    setBusy(true);
    try {
      const ethSide = direction === "eth->qrl" ? fromAmount : toAmount;
      const qrlSide = direction === "eth->qrl" ? toAmount : fromAmount;
      const ethUnits = parseAmount(ethSide, asset.decimals, asset.symbol);
      const qrlWei = parseAmount(qrlSide, 18, QRL_LEG.asset);
      if (ethUnits < asset.minBaseUnits) {
        throw new Error(
          `${asset.symbol} amount must be at least ${trimAmount(asset.minBaseUnits, asset.decimals)}`,
        );
      }
      if (qrlWei < MIN_QRL_AMOUNT_WEI) {
        throw new Error(`QRL amount must be at least ${trimAmount(MIN_QRL_AMOUNT_WEI, 18)}`);
      }
      const fromUnits = direction === "eth->qrl" ? ethUnits : qrlWei;
      const toUnits = direction === "eth->qrl" ? qrlWei : ethUnits;
      const restrictEth = allowedEth.trim();
      const restrictQrl = allowedQrl.trim();
      if (isPrivate) {
        if (restrictEth && !ETH_ADDR_RE.test(restrictEth)) {
          throw new Error("Taker ETH address must be a 0x-prefixed 20-byte address");
        }
        if (restrictQrl && !QRL_ADDR_RE.test(restrictQrl)) {
          throw new Error("Taker QRL address must be a Q-prefixed 20-byte address");
        }
      }
      const { order, makerToken, shareToken } = await createOrder({
        direction,
        asset: asset.symbol,
        fromAmount: fromUnits.toString(),
        toAmount: toUnits.toString(),
        makerEthAccount: ethAccount,
        makerQrlAccount: qrlAccount,
        ...(isPrivate
          ? {
              visibility: "private" as const,
              ...(restrictEth ? { allowedTakerEth: restrictEth } : {}),
              ...(restrictQrl ? { allowedTakerQrl: restrictQrl } : {}),
            }
          : {}),
      });
      // Anchor the terms we just posted, not the book's echo of them:
      // MyOrderCard builds the swap from this handle at match time.
      const ref: MyOrderRef = {
        id: order.id,
        token: makerToken,
        asset: asset.symbol,
        fromAmount: fromUnits.toString(),
        toAmount: toUnits.toString(),
        shareToken: shareToken ?? null,
      };
      saveMyOrder(ref);
      onPosted(ref);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to post order");
    } finally {
      setBusy(false);
    }
  };

  const assetPicker = (
    <select
      aria-label="Ethereum-leg asset"
      value={assetSymbol}
      onChange={(e) => {
        const next = ethAssetSymbolOrNull(e.target.value);
        if (next !== null) setAssetSymbol(next);
      }}
      className="absolute top-1/2 right-2 -translate-y-1/2 rounded-md border border-border/60 bg-muted/40 px-1.5 py-1 text-sm font-medium text-muted-foreground"
    >
      {ETH_ASSET_SYMBOLS.map((s) => (
        // Option rows live in the native popup, which ignores most CSS;
        // explicit colors (plus :root color-scheme) keep them readable
        // on platforms that render the list themselves.
        <option key={s} value={s} className="bg-popover text-foreground">
          {s}
        </option>
      ))}
    </select>
  );

  const legBox = (
    kind: "You give" | "You want",
    side: "eth" | "qrl",
    value: string,
    setValue: (v: string) => void,
  ) => (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{kind}</span>
        <span>{side === "eth" ? ETH_LEG.name : QRL_LEG.name}</span>
      </div>
      <div className="relative">
        <Input
          inputMode="decimal"
          placeholder={
            side === "eth" ? `min ${trimAmount(asset.minBaseUnits, asset.decimals)}` : "0.0"
          }
          value={value}
          onChange={(e) => {
            const next = e.target.value.replace(",", ".");
            if (next === "" || /^\d*\.?\d*$/.test(next)) setValue(next);
          }}
          className="font-data h-12 pr-20 text-lg"
        />
        {side === "eth" ? (
          assetPicker
        ) : (
          <span className="absolute top-1/2 right-3 -translate-y-1/2 text-sm font-medium text-muted-foreground">
            {QRL_LEG.asset}
          </span>
        )}
      </div>
    </div>
  );

  return (
    <Card className="surface-ember">
      <CardHeader className="pb-4">
        <div className="flex items-center justify-between">
          <CardTitle className="text-xl">Post an order</CardTitle>
          <span className="text-xs text-muted-foreground">HTLC protocol mode</span>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {legBox("You give", direction === "eth->qrl" ? "eth" : "qrl", fromAmount, setFromAmount)}
        <div className="flex justify-center">
          <Button
            variant="outline"
            size="icon"
            aria-label="switch direction"
            onClick={() => {
              setDirection((d) => (d === "eth->qrl" ? "qrl->eth" : "eth->qrl"));
              setFromAmount(toAmount);
              setToAmount(fromAmount);
            }}
          >
            <ArrowDownUp className="h-4 w-4" />
          </Button>
        </div>
        {legBox("You want", direction === "eth->qrl" ? "qrl" : "eth", toAmount, setToAmount)}

        <div className="space-y-1.5 rounded-md border border-border/60 bg-muted/20 p-3 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Receive {toSymbol} to</span>
            <span className="font-data text-xs text-blue-accent">
              {direction === "eth->qrl"
                ? qrlAccount
                  ? shortAddr(qrlAccount)
                  : "connect QRL wallet"
                : ethAccount
                  ? shortAddr(ethAccount)
                  : "connect ETH wallet"}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Timelocks</span>
            <span className="font-data">2h your leg / 1h taker leg</span>
          </div>
        </div>

        <div className="space-y-2">
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={isPrivate}
              onChange={(e) => setIsPrivate(e.target.checked)}
              className="h-4 w-4 accent-[hsl(var(--primary))]"
            />
            <span className="font-medium">Private swap</span>
            <span className="text-xs text-muted-foreground">
              hidden from the book, shared by link
            </span>
          </label>
          {isPrivate ? (
            <div className="space-y-2 rounded-md border border-border/60 bg-muted/20 p-3">
              <p className="text-xs leading-relaxed text-muted-foreground">
                You get a one-off link to hand to your counterparty (OTC style). Optionally
                reserve the order for their addresses; leave blank to let anyone with the link
                take it.
              </p>
              <Input
                placeholder="Taker ETH address (optional, 0x…)"
                value={allowedEth}
                onChange={(e) => setAllowedEth(e.target.value)}
                className="font-data h-9 text-xs"
              />
              <Input
                placeholder="Taker QRL address (optional, Q…)"
                value={allowedQrl}
                onChange={(e) => setAllowedQrl(e.target.value)}
                className="font-data h-9 text-xs"
              />
            </div>
          ) : null}
        </div>

        <Button className="w-full" size="lg" disabled={!ready || busy} onClick={() => void post()}>
          <BookPlus className="h-4 w-4" />
          {!ethAccount || !qrlAccount
            ? "Connect both wallets to post"
            : !(Number(fromAmount) > 0)
              ? `Enter the ${fromSymbol} amount`
              : !(Number(toAmount) > 0)
                ? `Enter the ${toSymbol} amount`
                : busy
                  ? "Posting…"
                  : isPrivate
                    ? "Post private order"
                    : "Post order"}
        </Button>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <p className="text-xs leading-relaxed text-muted-foreground">
          Posting is free and holds no funds. When a taker accepts, you lock first and the swap
          settles atomically through the HTLCs, or refunds after the timelocks.
        </p>
      </CardContent>
    </Card>
  );
}
