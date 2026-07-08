import { useCallback, useEffect, useMemo, useState } from "react";
import { formatEther } from "ethers";
import type { BrowserProvider } from "ethers";
import { Check } from "lucide-react";
import { ETH_LEG, QRL_LEG, legByKey } from "@/config";
import type { LegKey } from "@/config";
import {
  SwapStatus,
  buildClaimData,
  buildLockNativeData,
  buildRefundData,
  getLegState,
  type LegState,
} from "@/lib/htlc";
import { initiatorLeg, responderLeg, type DemoSwap } from "@/lib/demoSwap";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/UI/Card";
import { Button } from "@/components/UI/Button";
import { cn } from "@/utils/cn";

const ZERO32 = `0x${"0".repeat(64)}`;

interface Props {
  swap: DemoSwap;
  browserProvider: BrowserProvider | null;
  ensureSepolia: () => Promise<void>;
  qrlRequest: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  onDiscard: () => void;
}

type LegStates = Partial<Record<LegKey, LegState>>;

const pillStyles: Record<string, string> = {
  none: "bg-muted/40 text-muted-foreground",
  open: "bg-blue-accent/10 text-blue-accent",
  claimed: "bg-emerald-400/10 text-emerald-400",
  refunded: "bg-amber-400/10 text-amber-400",
};

const statusName = ["none", "open", "claimed", "refunded"] as const;

function StatusPill({ state }: { state: LegState | undefined }) {
  const name = (state ? statusName[state.status] : undefined) ?? "none";
  return (
    <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-medium", pillStyles[name])}>
      {state ? name : "…"}
    </span>
  );
}

export function SwapFlow({ swap, browserProvider, ensureSepolia, qrlRequest, onDiscard }: Props) {
  const [legs, setLegs] = useState<LegStates>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSecret, setShowSecret] = useState(false);
  const [nowS, setNowS] = useState(() => Math.floor(Date.now() / 1000));

  const iLeg = initiatorLeg(swap);
  const rLeg = responderLeg(swap);
  const iCfg = legByKey(iLeg);
  const rCfg = legByKey(rLeg);

  const refresh = useCallback(async () => {
    try {
      const [i, r] = await Promise.all([getLegState(iLeg, swap.hashlock), getLegState(rLeg, swap.hashlock)]);
      setLegs({ [iLeg]: i, [rLeg]: r });
      setNowS(Math.floor(Date.now() / 1000));
    } catch {
      // transient RPC failure; next poll retries
    }
  }, [iLeg, rLeg, swap.hashlock]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const iState = legs[iLeg];
  const rState = legs[rLeg];

  // Amounts/recipients per leg. In the sandbox you play both roles, so each
  // leg pays out to your own account on that chain.
  const legPlan = useMemo(
    () => ({
      eth: { recipient: swap.ethAccount, amount: BigInt(swap.direction === "eth->qrl" ? swap.fromAmount : swap.toAmount) },
      qrl: { recipient: swap.qrlAccount, amount: BigInt(swap.direction === "eth->qrl" ? swap.toAmount : swap.fromAmount) },
    }),
    [swap]
  );

  const timeoutOf = (leg: LegKey) => (leg === iLeg ? swap.initiatorTimeout : swap.responderTimeout);

  const sendOnLeg = useCallback(
    async (leg: LegKey, data: string, valueWei: bigint) => {
      if (leg === "eth") {
        if (!browserProvider) throw new Error("Ethereum wallet not connected");
        await ensureSepolia();
        const signer = await browserProvider.getSigner();
        const tx = await signer.sendTransaction({ to: ETH_LEG.htlc, data, value: valueWei });
        await tx.wait();
      } else {
        await qrlRequest({
          method: "qrl_sendTransaction",
          params: [
            {
              from: swap.qrlAccount,
              to: QRL_LEG.htlc,
              data,
              ...(valueWei > 0n ? { value: `0x${valueWei.toString(16)}` } : {}),
            },
          ],
        });
      }
    },
    [browserProvider, ensureSepolia, qrlRequest, swap.qrlAccount]
  );

  const runAction = (key: string, fn: () => Promise<void>) => {
    setError(null);
    setBusy(key);
    void fn()
      .then(refresh)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(null));
  };

  const lockLeg = (leg: LegKey) =>
    runAction(`lock-${leg}`, async () => {
      const plan = legPlan[leg];
      await sendOnLeg(leg, buildLockNativeData(swap.hashlock, plan.recipient, timeoutOf(leg)), plan.amount);
    });

  const claimLeg = (leg: LegKey, preimage: string) =>
    runAction(`claim-${leg}`, async () => {
      await sendOnLeg(leg, buildClaimData(swap.hashlock, preimage), 0n);
    });

  const refundLeg = (leg: LegKey) =>
    runAction(`refund-${leg}`, async () => {
      await sendOnLeg(leg, buildRefundData(swap.hashlock), 0n);
    });

  const revealedPreimage = rState && rState.preimage !== ZERO32 ? rState.preimage : null;

  const steps = [
    {
      title: `Lock ${iCfg.asset} on ${iCfg.name}`,
      desc: `You (initiator) escrow ${formatEther(legPlan[iLeg].amount)} ${iCfg.asset} under the hashlock. Refundable after ${new Date(swap.initiatorTimeout * 1000).toLocaleTimeString()}.`,
      done: Boolean(iState && iState.status !== SwapStatus.None),
      canRun: Boolean(iState && iState.status === SwapStatus.None),
      action: () => lockLeg(iLeg),
      busyKey: `lock-${iLeg}`,
      label: `Lock ${iCfg.asset}`,
    },
    {
      title: `Lock ${rCfg.asset} on ${rCfg.name}`,
      desc: `The counterparty (also you, in this sandbox) sees the initiator lock and escrows ${formatEther(legPlan[rLeg].amount)} ${rCfg.asset} under the same hashlock, with the shorter timeout.`,
      done: Boolean(rState && rState.status !== SwapStatus.None),
      canRun: Boolean(iState && iState.status === SwapStatus.Open && rState && rState.status === SwapStatus.None),
      action: () => lockLeg(rLeg),
      busyKey: `lock-${rLeg}`,
      label: `Lock ${rCfg.asset}`,
    },
    {
      title: `Claim ${rCfg.asset} (reveals the secret)`,
      desc: "The initiator claims the responder leg. The preimage becomes public on-chain; from here the swap can only complete.",
      done: Boolean(rState && rState.status === SwapStatus.Claimed),
      canRun: Boolean(rState && rState.status === SwapStatus.Open && nowS < swap.responderTimeout),
      action: () => claimLeg(rLeg, swap.preimage),
      busyKey: `claim-${rLeg}`,
      label: `Claim ${rCfg.asset}`,
    },
    {
      title: `Claim ${iCfg.asset} with the revealed secret`,
      desc: "The counterparty reads the now-public preimage from the other chain and claims the initiator leg. No trust required at any point.",
      done: Boolean(iState && iState.status === SwapStatus.Claimed),
      canRun: Boolean(revealedPreimage && iState && iState.status === SwapStatus.Open && nowS < swap.initiatorTimeout),
      action: () => revealedPreimage && claimLeg(iLeg, revealedPreimage),
      busyKey: `claim-${iLeg}`,
      label: `Claim ${iCfg.asset}`,
    },
  ];

  const complete = iState?.status === SwapStatus.Claimed && rState?.status === SwapStatus.Claimed;
  const refundables = (["eth", "qrl"] as LegKey[]).filter(
    (leg) => legs[leg]?.status === SwapStatus.Open && nowS >= timeoutOf(leg)
  );

  return (
    <Card className="border-l-2 border-l-secondary">
      <CardHeader className="pb-4">
        <div className="flex items-center justify-between">
          <CardTitle className="text-xl">Swap in progress</CardTitle>
          <span className="font-mono text-xs text-muted-foreground" title={swap.hashlock}>
            {swap.hashlock.slice(0, 14)}…
          </span>
        </div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span>{iCfg.name} leg</span>
          <StatusPill state={iState} />
          <span>· {rCfg.name} leg</span>
          <StatusPill state={rState} />
        </div>
      </CardHeader>
      <CardContent className="space-y-1">
        {complete ? (
          <div className="mb-3 rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3 text-center text-sm font-semibold text-emerald-400">
            Atomic swap complete on both chains
          </div>
        ) : null}

        {steps.map((step, i) => (
          <div
            key={step.title}
            className="flex gap-3 border-b border-border/60 py-3.5 last:border-b-0"
          >
            <div
              className={cn(
                "flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold",
                step.done
                  ? "border-emerald-400/60 bg-emerald-400/10 text-emerald-400"
                  : step.canRun
                    ? "border-blue-accent/60 text-blue-accent"
                    : "border-border text-muted-foreground"
              )}
            >
              {step.done ? <Check className="h-3.5 w-3.5" /> : i + 1}
            </div>
            <div className="flex-1 space-y-1">
              <h3 className="text-sm font-medium">{step.title}</h3>
              <p className="text-xs leading-relaxed text-muted-foreground">{step.desc}</p>
              {!step.done && (
                <Button
                  size="sm"
                  className="mt-1"
                  disabled={!step.canRun || busy !== null}
                  onClick={step.action}
                >
                  {busy === step.busyKey ? "Waiting for wallet…" : step.label}
                </Button>
              )}
            </div>
          </div>
        ))}

        {refundables.length > 0 && !complete ? (
          <div className="flex gap-2 pt-3">
            {refundables.map((leg) => (
              <Button
                key={leg}
                variant="destructive"
                size="sm"
                disabled={busy !== null}
                onClick={() => refundLeg(leg)}
              >
                Refund {legByKey(leg).asset} leg
              </Button>
            ))}
          </div>
        ) : null}

        {error ? <p className="pt-2 text-sm break-words text-red-400">{error}</p> : null}

        <div className="flex items-center justify-between pt-4">
          <Button variant="link" size="sm" className="h-auto p-0" onClick={() => setShowSecret((v) => !v)}>
            {showSecret ? "Hide secret" : "Reveal secret (stays in this browser)"}
          </Button>
          <Button
            variant="link"
            size="sm"
            className="h-auto p-0"
            onClick={() => {
              if (
                complete ||
                window.confirm(
                  "Discard this swap? If funds are still locked you will need the refund buttons later; the secret is deleted."
                )
              )
                onDiscard();
            }}
          >
            {complete ? "New swap" : "Discard swap"}
          </Button>
        </div>
        {showSecret ? (
          <p className="font-mono text-xs break-all text-muted-foreground">{swap.preimage}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}
