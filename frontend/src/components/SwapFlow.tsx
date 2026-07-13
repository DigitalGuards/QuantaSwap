import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { formatUnits } from "ethers";
import type { BrowserProvider } from "ethers";
import { Check } from "lucide-react";
import { ETH_ASSETS, legByKey } from "@/config";
import type { LegKey } from "@/config";
import {
  buildClaimData,
  buildLockNativeData,
  buildLockTokenData,
  buildRefundData,
  getConfirmedLegState,
  getLegState,
  getSwapEvents,
  type LegState,
  type SwapEvent,
} from "@/lib/htlc";
import { makeLegSender, sendEthTokenLock } from "@/lib/legSender";
import { initiatorLeg, responderLeg, type ActiveSwap } from "@/lib/activeSwap";
import { getOrder, type OrderView } from "@/lib/orderbook";
import {
  deriveSwapMachine,
  sameAddr,
  type LegPlan,
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
  claimed: "bg-success/10 text-success",
  refunded: "bg-amber-400/10 text-amber-400",
};

const statusName = ["none", "open", "claimed", "refunded"] as const;

// With confirmations 0 (testnet speed, see config.ts) there is no depth
// wait to describe; the pending state only shows while the confirmed
// snapshot catches up to the latest leg read.
const depthWait = (confirmations: number): string =>
  confirmations > 0
    ? `waiting for ${confirmations}-block confirmation depth`
    : "confirming it at the chain head";

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
  // Sub-step progress for multi-transaction lock flows (ERC-20 legs need
  // approve, sometimes an approvalRace reset first, then lockToken); shown
  // on the busy button so the user knows which wallet prompt this is.
  const [lockStage, setLockStage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSecret, setShowSecret] = useState(false);
  const [nowS, setNowS] = useState(() => Math.floor(Date.now() / 1000));
  // The order-book view of this swap, polled alongside chain state. Used to
  // notice a taker walk-away (released) before the maker locks; funds are
  // still governed on-chain, so this is advisory only.
  const [order, setOrder] = useState<OrderView | null>(null);

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

  // Advance the clock on the wall, independent of RPC success: the time
  // gates (secret reveal, refund availability) must keep tightening even
  // through an RPC outage, or they would evaluate against a frozen `nowS`
  // and stay open past their real deadline.
  useEffect(() => {
    const t = setInterval(() => setNowS(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  // Explorer links for every step, recovered from the HTLCs' own events
  // (indexed by hashlock), so the counterparty's transactions get links
  // too, not just our own. Refetched when a leg's status changes.
  const [legEvents, setLegEvents] = useState<Record<LegKey, SwapEvent[]>>({ qrl: [], eth: [] });
  const iStatus = legs[iLeg]?.status;
  const rStatus = legs[rLeg]?.status;
  useEffect(() => {
    if (!hashlock) return undefined;
    let alive = true;
    void Promise.all([
      getSwapEvents("qrl", hashlock).catch((): SwapEvent[] => []),
      getSwapEvents("eth", hashlock).catch((): SwapEvent[] => []),
    ]).then(([qrl, eth]) => {
      if (alive) setLegEvents({ qrl, eth });
    });
    return () => {
      alive = false;
    };
  }, [hashlock, iStatus, rStatus]);

  // Poll the order-book view so a maker sees a taker's walk-away (released)
  // before committing funds. Best-effort: chain state remains authoritative.
  const orderId = swap.orderId;
  useEffect(() => {
    if (!orderId) return undefined;
    let stop = false;
    const poll = async () => {
      try {
        const view = await getOrder(orderId);
        if (!stop) setOrder(view);
      } catch {
        // transient or gone; ignore, the chain governs the funds
      }
    };
    void poll();
    const t = setInterval(() => void poll(), 5000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [orderId]);

  // Shared with the prelock post flow; see lib/legSender.ts for the
  // transport quirks (extension gas shape, approve targeting).
  const sendOnLeg = useMemo(
    () => makeLegSender({ browserProvider, ensureSepolia, qrlAccount, qrlTransport, qrlRequest }),
    [browserProvider, ensureSepolia, qrlRequest, qrlAccount, qrlTransport],
  );

  const runAction = (key: string, fn: () => Promise<void>) => {
    setError(null);
    setBusy(key);
    void fn()
      .then(refresh)
      .catch((err: unknown) => setError(errorMessage(err)))
      .finally(() => {
        setBusy(null);
        setLockStage(null);
      });
  };

  if (!machine || !hashlock || initiatorTimeout === null) {
    return null;
  }

  const { steps, complete, revealedPreimage, refundableLegs, ownLockedLegs, ownEth, ownQrl, legPlan } =
    machine;

  // The taker released their take before we (the maker) locked: our own leg
  // has nothing on chain yet, so do not lock into a walked-away swap.
  const takerWalkedAway =
    swap.role === "maker" &&
    ownLockedLegs.length === 0 &&
    (order?.released === true || order?.status === "cancelled");
  const iCfg = legByKey(iLeg);
  const rCfg = legByKey(rLeg);
  const iState = legs[iLeg];
  const rState = legs[rLeg];
  const ethAsset = ETH_ASSETS[swap.ethAsset];
  const iPlan = legPlan[iLeg];
  const rPlan = legPlan[rLeg];
  const fmtLeg = (plan: LegPlan) => `${formatUnits(plan.amount, plan.decimals)} ${plan.symbol}`;

  const lockLeg = (leg: LegKey) =>
    runAction(`lock-${leg}`, async () => {
      const plan = legPlan[leg];
      const timeout = leg === iLeg ? initiatorTimeout : (swap.responderTimeout ?? 0);
      if (leg === "eth" && ethAsset.address !== null) {
        // The USDT-safe approve/reset/lock sequencer lives in legSender.ts
        // (shared with the prelock post flow); only the calldata differs.
        await sendEthTokenLock({
          send: sendOnLeg,
          ethAccount,
          token: ethAsset.address,
          symbol: ethAsset.symbol,
          amount: plan.amount,
          approvalRace: ethAsset.quirks.approvalRace,
          lockData: buildLockTokenData(
            hashlock,
            plan.recipient,
            ethAsset.address,
            plan.amount,
            timeout,
          ),
          onStage: setLockStage,
        });
      } else {
        await sendOnLeg(leg, buildLockNativeData(hashlock, plan.recipient, timeout), plan.amount);
      }
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
  const initiatorRefundAt = iState?.timeout ?? initiatorTimeout;

  const presentation: Record<
    StepModel["key"],
    {
      title: string;
      desc: string;
      label: string;
      action: () => void;
      pendingText: string | null;
      /** Shown to the party who does NOT sign this step while it is the
       *  live step, so waiting reads as progress, not a stall. */
      waitingText: string;
    }
  > = {
    "lock-initiator": {
      title: `Lock ${iPlan.symbol} on ${iCfg.name}`,
      desc: `${who(steps[0].own)} (initiator) escrow${steps[0].own ? "" : "s"} ${fmtLeg(iPlan)} under the hashlock${iLeg === "eth" && ethAsset.address !== null ? ", approving the HTLC for the exact amount first" : ""}. Refundable after ${new Date(initiatorRefundAt * 1000).toLocaleTimeString()}.`,
      label: `Lock ${iPlan.symbol}`,
      action: () => lockLeg(iLeg),
      pendingText: null,
      waitingText: `The maker published the hashlock and is broadcasting their lock on ${iCfg.name}; blocks there confirm in about a minute.`,
    },
    "lock-responder": {
      title: `Lock ${rPlan.symbol} on ${rCfg.name}`,
      desc: `${who(steps[1].own)} (responder) verif${steps[1].own ? "y" : "ies"} the initiator lock on-chain, then escrow${steps[1].own ? "" : "s"} ${fmtLeg(rPlan)} under the same hashlock with the shorter timeout${rLeg === "eth" && ethAsset.address !== null ? ", approving the HTLC for the exact amount first" : ""}.`,
      label: `Lock ${rPlan.symbol}`,
      action: () => lockLeg(rLeg),
      pendingText: `Initiator lock detected on ${iCfg.name}; ${depthWait(iCfg.confirmations)} before it is safe to respond.`,
      waitingText: "Waiting for the taker to lock their leg…",
    },
    "claim-responder": {
      title: `Claim ${rPlan.symbol} (reveals the secret)`,
      desc: `${who(steps[2].own)} (initiator) claim${steps[2].own ? "" : "s"} the responder leg. The preimage becomes public on-chain; from here the swap can only complete.`,
      label: `Claim ${rPlan.symbol}`,
      action: () => swap.preimage && claimLeg(rLeg, swap.preimage),
      pendingText: `Responder lock detected on ${rCfg.name}; ${depthWait(rCfg.confirmations)} before the secret is safe to reveal.`,
      waitingText: "Waiting for the maker to claim and reveal the secret…",
    },
    "claim-initiator": {
      title: `Claim ${iPlan.symbol} with the revealed secret`,
      desc: `${who(steps[3].own)} read${steps[3].own ? "" : "s"} the now-public preimage from the other chain and claim${steps[3].own ? "" : "s"} the initiator leg. No trust required at any point.`,
      label: `Claim ${iPlan.symbol}`,
      action: () => revealedPreimage && claimLeg(iLeg, revealedPreimage),
      pendingText: null,
      waitingText: "Waiting for the taker to claim…",
    },
  };

  const accountMismatch =
    (ethAccount && !sameAddr(ethAccount, ownEth)) || (qrlAccount && !sameAddr(qrlAccount, ownQrl));

  const roleLabel =
    swap.role === "maker" ? "your order" : swap.role === "taker" ? "taken order" : "sandbox";

  return (
    <Card className="surface-ember">
      <CardHeader className="pb-4">
        <div className="flex items-center justify-between">
          <CardTitle className="text-xl">Swap in progress</CardTitle>
          <span className="text-xs text-muted-foreground">
            {roleLabel} ·{" "}
            <Link
              to={`/swap/${hashlock}`}
              className="font-data underline-offset-4 hover:underline"
              title="Shareable status page for this swap"
            >
              {hashlock.slice(0, 14)}…
            </Link>
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
          <div className="mb-3 rounded-md border border-success/40 bg-success/10 p-3 text-center text-sm font-semibold text-success">
            Atomic swap complete on both chains
          </div>
        ) : null}

        {accountMismatch ? (
          <p className="mb-2 rounded-md border border-amber-400/40 bg-amber-400/10 p-2 text-xs text-amber-400">
            A connected wallet differs from the address this swap was agreed with. Payouts still go
            to the agreed addresses (<span className="font-data">{ownEth.slice(0, 8)}…</span> /{" "}
            <span className="font-data">{ownQrl.slice(0, 8)}…</span>).
          </p>
        ) : null}

        {steps.map((step, i) => {
          const view = presentation[step.key];
          const stepTxHash =
            legEvents[step.leg].find(
              (e) => e.kind === (step.key.startsWith("lock") ? "locked" : "claimed"),
            )?.txHash ?? null;
          return (
            <div
              key={step.key}
              className="flex gap-3 border-b border-border/60 py-3.5 last:border-b-0"
            >
              <div
                className={cn(
                  "flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold",
                  step.done
                    ? "border-success/60 bg-success/10 text-success"
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
                  <p className="text-xs text-destructive">
                    Not safe to proceed: the counterparty lock failed verification, {step.issue}.
                  </p>
                ) : null}
                {!step.done && !step.issue && step.awaitingDepth && view.pendingText ? (
                  <p className="text-xs text-amber-400">{view.pendingText}</p>
                ) : null}
                {stepTxHash ? (
                  <p>
                    <a
                      className="text-xs text-muted-foreground underline-offset-4 hover:underline"
                      href={`${legByKey(step.leg).explorerTx}${stepTxHash}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      view transaction on explorer
                    </a>
                  </p>
                ) : null}
                {!step.done &&
                  (step.own ? (
                    <div className="space-y-1">
                      {step.key === "lock-initiator" && takerWalkedAway ? (
                        <p className="text-xs text-amber-400">
                          The taker walked away before you locked. Do not lock; discard this swap
                          below.
                        </p>
                      ) : null}
                      <Button
                        size="sm"
                        className="mt-1"
                        disabled={
                          !step.canRun ||
                          busy !== null ||
                          (step.key === "lock-initiator" && takerWalkedAway)
                        }
                        onClick={view.action}
                      >
                        {busy === `${step.key.startsWith("lock") ? "lock" : "claim"}-${step.leg}`
                          ? lockStage !== null
                            ? `${lockStage}…`
                            : "Waiting for wallet…"
                          : view.label}
                      </Button>
                    </div>
                  ) : step.canRun ? (
                    <p className="text-xs text-blue-accent">{view.waitingText}</p>
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
                Refund {legPlan[leg].symbol} leg
              </Button>
            ))}
          </div>
        ) : null}

        {error ? <p className="pt-2 text-sm break-words text-destructive">{error}</p> : null}

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
          {complete ? (
            <Button variant="link" size="sm" className="h-auto p-0" onClick={onDiscard}>
              New swap
            </Button>
          ) : ownLockedLegs.length > 0 ? (
            <span className="max-w-[60%] text-right text-xs text-amber-400">
              Your {ownLockedLegs.map((leg) => legPlan[leg].symbol).join(" and ")} is locked
              on-chain. Refund it below once the timeout opens before discarding: discarding now
              deletes the hashlock this swap needs to refund.
            </span>
          ) : (
            <Button
              variant="link"
              size="sm"
              className="h-auto p-0"
              onClick={() => {
                if (
                  window.confirm(
                    "Discard this swap? Nothing is locked on your side, so no funds are at risk. Local swap state is deleted.",
                  )
                )
                  onDiscard();
              }}
            >
              Discard swap
            </Button>
          )}
        </div>
        {showSecret && swap.preimage ? (
          <p className="font-data text-xs break-all text-muted-foreground">{swap.preimage}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}
