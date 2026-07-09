import { useState } from "react";
import { parseEther } from "ethers";
import { ArrowDownUp, BookPlus } from "lucide-react";
import { ETH_LEG, MIN_AMOUNT_WEI, QRL_LEG } from "@/config";
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

export function PostOrderCard({ ethAccount, qrlAccount, onPosted }: Props) {
  const [direction, setDirection] = useState<Direction>("eth->qrl");
  const [fromAmount, setFromAmount] = useState("");
  const [toAmount, setToAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const fromLeg = direction === "eth->qrl" ? ETH_LEG : QRL_LEG;
  const toLeg = direction === "eth->qrl" ? QRL_LEG : ETH_LEG;

  const ready = Boolean(ethAccount && qrlAccount && Number(fromAmount) > 0 && Number(toAmount) > 0);

  const post = async () => {
    if (!ethAccount || !qrlAccount) return;
    setError(null);
    setBusy(true);
    try {
      const fromWei = parseEther(fromAmount);
      const toWei = parseEther(toAmount);
      if (fromWei < MIN_AMOUNT_WEI || toWei < MIN_AMOUNT_WEI) {
        throw new Error("Amounts must be at least 0.001");
      }
      const { order, makerToken } = await createOrder({
        direction,
        fromAmount: fromWei.toString(),
        toAmount: toWei.toString(),
        makerEthAccount: ethAccount,
        makerQrlAccount: qrlAccount,
      });
      const ref: MyOrderRef = { id: order.id, token: makerToken };
      saveMyOrder(ref);
      onPosted(ref);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to post order");
    } finally {
      setBusy(false);
    }
  };

  const legBox = (
    kind: "You give" | "You want",
    leg: typeof ETH_LEG | typeof QRL_LEG,
    value: string,
    setValue: (v: string) => void,
  ) => (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{kind}</span>
        <span>{leg.name}</span>
      </div>
      <div className="relative">
        <Input
          inputMode="decimal"
          placeholder="0.0"
          value={value}
          onChange={(e) => {
            const next = e.target.value.replace(",", ".");
            if (next === "" || /^\d*\.?\d*$/.test(next)) setValue(next);
          }}
          className="h-12 pr-16 text-lg"
        />
        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm font-medium text-muted-foreground">
          {leg.asset}
        </span>
      </div>
    </div>
  );

  return (
    <Card className="border-l-2 border-l-secondary">
      <CardHeader className="pb-4">
        <div className="flex items-center justify-between">
          <CardTitle className="text-xl">Post an order</CardTitle>
          <span className="text-xs text-muted-foreground">HTLC protocol mode</span>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {legBox("You give", fromLeg, fromAmount, setFromAmount)}
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
        {legBox("You want", toLeg, toAmount, setToAmount)}

        <div className="space-y-1.5 rounded-md border border-border/60 bg-muted/20 p-3 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Receive {toLeg.asset} to</span>
            <span className="font-mono text-xs">
              {toLeg.key === "qrl"
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
            <span>2h your leg / 1h taker leg</span>
          </div>
        </div>

        <Button className="w-full" size="lg" disabled={!ready || busy} onClick={() => void post()}>
          <BookPlus className="h-4 w-4" />
          {!ethAccount || !qrlAccount
            ? "Connect both wallets to post"
            : !(Number(fromAmount) > 0)
              ? `Enter the ${fromLeg.asset} amount`
              : !(Number(toAmount) > 0)
                ? `Enter the ${toLeg.asset} amount`
                : busy
                  ? "Posting…"
                  : "Post order"}
        </Button>
        {error ? <p className="text-sm text-red-400">{error}</p> : null}
        <p className="text-xs leading-relaxed text-muted-foreground">
          Posting is free and holds no funds. When a taker accepts, you lock first and the swap
          settles atomically through the HTLCs, or refunds after the timelocks.
        </p>
      </CardContent>
    </Card>
  );
}
