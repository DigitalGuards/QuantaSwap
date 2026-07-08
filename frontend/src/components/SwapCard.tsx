import { useState } from "react";
import { parseEther } from "ethers";
import { ArrowDownUp, ArrowLeftRight } from "lucide-react";
import { ETH_LEG, INITIATOR_TIMEOUT_S, QRL_LEG, RESPONDER_TIMEOUT_S } from "@/config";
import type { DemoSwap } from "@/lib/demoSwap";
import { generateSecret } from "@/lib/secrets";
import { shortAddr } from "@/lib/htlc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/UI/Card";
import { Button } from "@/components/UI/Button";
import { Input } from "@/components/UI/Input";

interface Props {
  ethAccount: string | null;
  qrlAccount: string | null;
  onStart: (swap: DemoSwap) => void;
}

export function SwapCard({ ethAccount, qrlAccount, onStart }: Props) {
  const [direction, setDirection] = useState<DemoSwap["direction"]>("eth->qrl");
  const [fromAmount, setFromAmount] = useState("");
  const [toAmount, setToAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const fromLeg = direction === "eth->qrl" ? ETH_LEG : QRL_LEG;
  const toLeg = direction === "eth->qrl" ? QRL_LEG : ETH_LEG;

  const ready = Boolean(ethAccount && qrlAccount && Number(fromAmount) > 0 && Number(toAmount) > 0);

  const start = async () => {
    if (!ethAccount || !qrlAccount) return;
    setError(null);
    setBusy(true);
    try {
      const secret = await generateSecret();
      const now = Math.floor(Date.now() / 1000);
      onStart({
        direction,
        preimage: secret.preimage,
        hashlock: secret.hashlock,
        fromAmount: parseEther(fromAmount).toString(),
        toAmount: parseEther(toAmount).toString(),
        ethAccount,
        qrlAccount,
        initiatorTimeout: now + INITIATOR_TIMEOUT_S,
        responderTimeout: now + RESPONDER_TIMEOUT_S,
        createdAt: now,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid amount");
    } finally {
      setBusy(false);
    }
  };

  const legBox = (
    kind: "From" | "To",
    leg: typeof ETH_LEG | typeof QRL_LEG,
    value: string,
    setValue: (v: string) => void
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
          <CardTitle className="text-xl">Swap</CardTitle>
          <span className="text-xs text-muted-foreground">HTLC protocol mode</span>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {legBox("From", fromLeg, fromAmount, setFromAmount)}
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
        {legBox("To", toLeg, toAmount, setToAmount)}

        <div className="space-y-1.5 rounded-md border border-border/60 bg-muted/20 p-3 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Receive to</span>
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
            <span>2h initiator / 1h responder</span>
          </div>
        </div>

        <Button className="w-full" size="lg" disabled={!ready || busy} onClick={() => void start()}>
          <ArrowLeftRight className="h-4 w-4" />
          {ethAccount && qrlAccount ? "Start atomic swap" : "Connect both wallets to swap"}
        </Button>
        {error ? <p className="text-sm text-red-400">{error}</p> : null}
        <p className="text-xs leading-relaxed text-muted-foreground">
          Protocol-mode sandbox: no order book yet, so you act as both sides of the swap and can
          watch the HTLC handshake happen live on both chains. Rates are whatever you enter.
        </p>
      </CardContent>
    </Card>
  );
}
