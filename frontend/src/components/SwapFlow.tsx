import { useCallback, useEffect, useMemo, useState } from "react";
import { formatEther } from "ethers";
import type { BrowserProvider } from "ethers";
import { Check } from "lucide-react";
import { ETH_LEG, QRL_LEG, legByKey } from "@/config";
import type { LegKey } from "@/config";
import {
  buildClaimData,
  buildLockNativeData,
  buildRefundData,
  getConfirmedLegState,
  getLegState,
  qrlRpc,
  type LegState,
} from "@/lib/htlc";
import { initiatorLeg, responderLeg, type ActiveSwap } from "@/lib/activeSwap";
import {
  deriveSwapMachine,
  sameAddr,
  type LegStates,
  type StepModel,
} from "@/lib/swapMachine";
import type { QrlTransport } from "@/hooks/useQrlWallet";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/UI/Card";
import { Button } from "@/components/UI/Button";
import { cn } from "@/utils/cn";
import { errorMessage } from "@/utils/errorMessage";

interface Props {
  swap: ActiveSwap;
  ethAccount: string | null;
  qrlAccount: string | null;
  browserProvider: BrowserProvider | null;
  ensureSepolia: () => Promise<void>;
  qrlRequest: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  /** Active QRL transport; the extension needs an explicit gas limit. */
  qrlTransport: QrlTransport | null;
  onDiscard: () => void;
}

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

export function SwapFlow({
  swap,
  ethAccount,
  qrlAccount,
  browserProvider,
  ensureSepolia,
  qrlRequest,
  qrlTransport,
  onDiscard,
}: Props) {
  const [legs, setLegs] = useState<LegStates>({});
  // Snapshot at `confirmations` blocks behind the head; the gate for the
  // two irreversible responses (taker locks, maker reveals the secret).
  const [confirmedLegs, setConfirmedLegs] = useState<LegStates>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSecret, setShowSecret] = useState(false);
  const [nowS, setNowS] = useState(() => Math.floor(Date.now() / 1000));

  const { hashlock, initiatorTimeout } = swap;

  const iLeg = initiatorLeg(swap.direction);
  const rLeg = responderLeg(swap.direction);

  const machine = useMemo(
    () => deriveSwapMachine({ swap, legs, confirmed: confirmedLegs, nowS }),
    [swap, legs, confirmedLegs, nowS],
  );

  const refresh = useCallback(async () => {
    if (!hashlock) return;
    try {
      const [i, r] = await Promise.all([
        getLegState(iLeg, hashlock),
        getLegState(rLeg, hashlock),
      ]);
      setLegs({ [iLeg]: i, [rLeg]: r });
      setNowS(Math.floor(Date.now() / 1000));
    } catch {
      // transient RPC failure; next poll retries
      return;
    }
    // Confirmation-depth snapshot, fail-closed per leg: a failed historical
    // read leaves that leg unconfirmed rather than reusing a stale value,
    // so an RPC hiccup can never enable an irreversible step.
    const [ci, cr] = await Promise.allSettled([
      getConfirmedLegState(iLeg, hashlock),
      getConfirmedLegState(rLeg, hashlock),
    ]);
    const confirmed: LegStates = {};
    if (ci.status === "fulfilled") confirmed[iLeg] = ci.value;
    if (cr.status === "fulfilled") confirmed[rLeg] = cr.value;
    setConfirmedLegs(confirmed);
  }, [iLeg, rLeg, hashlock]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const sendOnLeg = useCallback(
    async (leg: LegKey, data: string, valueWei: bigint) => {
      if (leg === "eth") {
        if (!browserProvider) throw new Error("Ethereum wallet not connected");
        await ensureSepolia();
        const signer = await browserProvider.getSigner();
        const tx = await signer.sendTransaction({ to: ETH_LEG.htlc, data, value: valueWei });
        await tx.wait();
      } else {
        if (!qrlAccount) throw new Error("QRL wallet not connected");
        let tx: Record<string, unknown> = {
          from: qrlAccount,
          to: QRL_LEG.htlc,
          data,
          ...(valueWei > 0n ? { value: `0x${valueWei.toString(16)}` } : {}),
        };
        if (qrlTransport === "extension") {
          // The extension does not estimate gas; it feeds the dApp's fields
          // into @theqrl/web3 0.5 signTransaction. Its legacy (gasPrice)
          // branch fails web3 gas validation, so request type "0x2": the
          // extension then fills maxFee/maxPriorityFee itself, the exact
          // shape its own internal sends use. Numeric gas under both keys,
          // decimal-string value. The relay wallet estimates itself, so it
          // keeps the minimal hex shape.
          let gasLimit = 1_500_000;
          try {
            const estimated = (await qrlRpc("qrl_estimateGas", [tx])) as string;
            gasLimit = Number((BigInt(estimated) * 130n) / 100n);
          } catch {
            // estimation can fail on some proxies; fall back to a safe limit
          }
          tx = {
            from: qrlAccount,
            to: QRL_LEG.htlc,
            value: valueWei.toString(),
            data,
            gas: gasLimit,
            gasLimit,
            type: "0x2",
          };
        }
        await qrlRequest({ method: "qrl_sendTransaction", params: [tx] });
      }
    },
    [browserProvider, ensureSepolia, qrlRequest, qrlAccount, qrlTransport],
  );

  const runAction = (key: string, fn: () => Promise<void>) => {
    setError(null);
    setBusy(key);
    void fn()
      .then(refresh)
      .catch((err: unknown) => setError(errorMessage(err)))
      .finally(() => setBusy(null));
  };

  if (!machine || !hashlock || initiatorTimeout === null) {
    return null;
  }

  const { steps, complete, revealedPreimage, refundableLegs, ownEth, ownQrl, legPlan } = machine;
  const iCfg = legByKey(iLeg);
  const rCfg = legByKey(rLeg);
  const iState = legs[iLeg];
  const rState = legs[rLeg];

  const lockLeg = (leg: LegKey) =>
    runAction(`lock-${leg}`, async () => {
      const plan = legPlan[leg];
      const timeout = leg === iLeg ? initiatorTimeout : (swap.responderTimeout ?? 0);
      await sendOnLeg(leg, buildLockNativeData(hashlock, plan.recipient, timeout), plan.amount);
    });

  const claimLeg = (leg: LegKey, preimage: string) =>
    runAction(`claim-${leg}`, async () => {
      await sendOnLeg(leg, buildClaimData(hashlock, preimage), 0n);
    });

  const refundLeg = (leg: LegKey) =>
    runAction(`refund-${leg}`, async () => {
      await sendOnLeg(leg, buildRefundData(hashlock), 0n);
    });

  const who = (ownStep: boolean) => (ownStep ? "You" : "The counterparty");

  // Presentation for each machine step: copy, action wiring, pending text.
  const presentation: Record<
    StepModel["key"],
    { title: string; desc: string; label: string; action: () => void; pendingText: string | null }
  > = {
    "lock-initiator": {
      title: `Lock ${iCfg.asset} on ${iCfg.name}`,
      desc: `${who(steps[0].own)} (initiator) escrow${steps[0].own ? "" : "s"} ${formatEther(legPlan[iLeg].amount)} ${iCfg.asset} under the hashlock. Refundable after ${new Date(initiatorTimeout * 1000).toLocaleTimeString()}.`,
      label: `Lock ${iCfg.asset}`,
      action: () => lockLeg(iLeg),
      pendingText: null,
    },
    "lock-responder": {
      title: `Lock ${rCfg.asset} on ${rCfg.name}`,
      desc: `${who(steps[1].own)} (responder) verif${steps[1].own ? "y" : "ies"} the initiator lock on-chain, then escrow${steps[1].own ? "" : "s"} ${formatEther(legPlan[rLeg].amount)} ${rCfg.asset} under the same hashlock with the shorter timeout.`,
      label: `Lock ${rCfg.asset}`,
      action: () => lockLeg(rLeg),
      pendingText: `Initiator lock detected on ${iCfg.name}; waiting for ${iCfg.confirmations}-block confirmation depth before it is safe to respond.`,
    },
    "claim-responder": {
      title: `Claim ${rCfg.asset} (reveals the secret)`,
      desc: `${who(steps[2].own)} (initiator) claim${steps[2].own ? "" : "s"} the responder leg. The preimage becomes public on-chain; from here the swap can only complete.`,
      label: `Claim ${rCfg.asset}`,
      action: () => swap.preimage && claimLeg(rLeg, swap.preimage),
      pendingText: `Responder lock detected on ${rCfg.name}; waiting for ${rCfg.confirmations}-block confirmation depth before the secret is safe to reveal.`,
    },
    "claim-initiator": {
      title: `Claim ${iCfg.asset} with the revealed secret`,
      desc: `${who(steps[3].own)} read${steps[3].own ? "" : "s"} the now-public preimage from the other chain and claim${steps[3].own ? "" : "s"} the initiator leg. No trust required at any point.`,
      label: `Claim ${iCfg.asset}`,
      action: () => revealedPreimage && claimLeg(iLeg, revealedPreimage),
      pendingText: null,
    },
  };

  const accountMismatch =
    (ethAccount && !sameAddr(ethAccount, ownEth)) || (qrlAccount && !sameAddr(qrlAccount, ownQrl));

  const roleLabel =
    swap.role === "maker" ? "your order" : swap.role === "taker" ? "taken order" : "sandbox";

  return (
    <Card className="border-l-2 border-l-secondary">
      <CardHeader className="pb-4">
        <div className="flex items-center justify-between">
          <CardTitle className="text-xl">Swap in progress</CardTitle>
          <span className="text-xs text-muted-foreground">
            {roleLabel} ·{" "}
            <span className="font-mono" title={hashlock}>
              {hashlock.slice(0, 14)}…
            </span>
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

        {accountMismatch ? (
          <p className="mb-2 rounded-md border border-amber-400/40 bg-amber-400/10 p-2 text-xs text-amber-400">
            A connected wallet differs from the address this swap was agreed with. Payouts still go
            to the agreed addresses ({ownEth.slice(0, 8)}… / {ownQrl.slice(0, 8)}…).
          </p>
        ) : null}

        {steps.map((step, i) => {
          const view = presentation[step.key];
          return (
            <div
              key={step.key}
              className="flex gap-3 border-b border-border/60 py-3.5 last:border-b-0"
            >
              <div
                className={cn(
                  "flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold",
                  step.done
                    ? "border-emerald-400/60 bg-emerald-400/10 text-emerald-400"
                    : step.own && step.canRun
                      ? "border-blue-accent/60 text-blue-accent"
                      : "border-border text-muted-foreground",
                )}
              >
                {step.done ? <Check className="h-3.5 w-3.5" /> : i + 1}
              </div>
              <div className="flex-1 space-y-1">
                <h3 className="text-sm font-medium">{view.title}</h3>
                <p className="text-xs leading-relaxed text-muted-foreground">{view.desc}</p>
                {step.issue ? (
                  <p className="text-xs text-red-400">
                    Not safe to proceed: the counterparty lock failed verification, {step.issue}.
                  </p>
                ) : null}
                {!step.done && !step.issue && step.awaitingDepth && view.pendingText ? (
                  <p className="text-xs text-amber-400">{view.pendingText}</p>
                ) : null}
                {!step.done &&
                  (step.own ? (
                    <Button
                      size="sm"
                      className="mt-1"
                      disabled={!step.canRun || busy !== null}
                      onClick={view.action}
                    >
                      {busy === `${step.key.startsWith("lock") ? "lock" : "claim"}-${step.leg}`
                        ? "Waiting for wallet…"
                        : view.label}
                    </Button>
                  ) : step.canRun ? (
                    <p className="text-xs text-blue-accent">Waiting for the counterparty…</p>
                  ) : null)}
              </div>
            </div>
          );
        })}

        {refundableLegs.length > 0 && !complete ? (
          <div className="flex gap-2 pt-3">
            {refundableLegs.map((leg) => (
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
          {swap.preimage ? (
            <Button
              variant="link"
              size="sm"
              className="h-auto p-0"
              onClick={() => setShowSecret((v) => !v)}
            >
              {showSecret ? "Hide secret" : "Reveal secret (stays in this browser)"}
            </Button>
          ) : (
            <span className="text-xs text-muted-foreground">The secret stays with the maker</span>
          )}
          <Button
            variant="link"
            size="sm"
            className="h-auto p-0"
            onClick={() => {
              if (
                complete ||
                window.confirm(
                  "Discard this swap? If funds are still locked you will need the refund buttons later; local swap state is deleted.",
                )
              )
                onDiscard();
            }}
          >
            {complete ? "New swap" : "Discard swap"}
          </Button>
        </div>
        {showSecret && swap.preimage ? (
          <p className="font-mono text-xs break-all text-muted-foreground">{swap.preimage}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}
