import { useCallback, useEffect, useMemo, useState } from "react";
import { formatEther } from "ethers";
import type { BrowserProvider } from "ethers";
import { Check } from "lucide-react";
import { CLAIM_MARGIN_S, ETH_LEG, QRL_LEG, legByKey } from "@/config";
import type { LegKey } from "@/config";
import {
  SwapStatus,
  buildClaimData,
  buildLockNativeData,
  buildRefundData,
  getConfirmedLegState,
  getLegState,
  qToHex,
  qrlRpc,
  type LegState,
} from "@/lib/htlc";
import { initiatorLeg, responderLeg, type ActiveSwap } from "@/lib/activeSwap";
import type { QrlTransport } from "@/hooks/useQrlWallet";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/UI/Card";
import { Button } from "@/components/UI/Button";
import { cn } from "@/utils/cn";
import { errorMessage } from "@/utils/errorMessage";

const ZERO32 = `0x${"0".repeat(64)}`;

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

const sameAddr = (a: string, b: string): boolean =>
  qToHex(a).toLowerCase() === qToHex(b).toLowerCase();

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

  const { hashlock, initiatorTimeout, responderTimeout } = swap;
  const iLeg = initiatorLeg(swap.direction);
  const rLeg = responderLeg(swap.direction);
  const iCfg = legByKey(iLeg);
  const rCfg = legByKey(rLeg);

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

  const iState = legs[iLeg];
  const rState = legs[rLeg];
  const iConfirmed = confirmedLegs[iLeg];
  const rConfirmed = confirmedLegs[rLeg];

  // The head sees a lock the confirmed snapshot does not yet: it exists
  // but is still shallow enough for a reorg to rewrite. Anything acting on
  // that lock waits until it shows up at depth.
  const awaitingDepth = (latest: LegState | undefined, conf: LegState | undefined): boolean =>
    Boolean(latest && latest.status === SwapStatus.Open && conf?.status !== SwapStatus.Open);

  // Which of the four steps this browser drives. In the sandbox one person
  // plays both roles; in a real order-book swap each side only ever signs
  // its own two transactions.
  const mySteps: readonly [boolean, boolean, boolean, boolean] =
    swap.role === "maker"
      ? [true, false, true, false]
      : swap.role === "taker"
        ? [false, true, false, true]
        : [true, true, true, true];

  // Recipients are fixed at lock time and re-checked against chain state
  // before either party commits funds or reveals the secret.
  const addrOn = useCallback(
    (leg: LegKey, party: "maker" | "taker"): string =>
      leg === "eth"
        ? party === "maker"
          ? swap.makerEthAccount
          : swap.takerEthAccount
        : party === "maker"
          ? swap.makerQrlAccount
          : swap.takerQrlAccount,
    [swap],
  );

  const legPlan = useMemo(
    () => ({
      [iLeg]: { recipient: addrOn(iLeg, "taker"), amount: BigInt(swap.fromAmount) },
      [rLeg]: { recipient: addrOn(rLeg, "maker"), amount: BigInt(swap.toAmount) },
    }),
    [addrOn, iLeg, rLeg, swap.fromAmount, swap.toAmount],
  ) as Record<LegKey, { recipient: string; amount: bigint }>;

  const timeoutOf = (leg: LegKey) =>
    (leg === iLeg ? initiatorTimeout : responderTimeout) ?? 0;

  // Taker-side verification of the maker's lock before responding with
  // funds. The order book announced the parameters; the chain confirms
  // them. Checked against the confirmation-depth snapshot, not the head:
  // a shallow lock could still be reorged into a different one.
  const initiatorLockIssue = useMemo(() => {
    if (!iConfirmed || iConfirmed.status !== SwapStatus.Open || responderTimeout === null)
      return null;
    if (!sameAddr(iConfirmed.recipient, legPlan[iLeg].recipient))
      return "its recipient is not your address";
    if (iConfirmed.amount !== legPlan[iLeg].amount)
      return `it escrows ${formatEther(iConfirmed.amount)} ${iCfg.asset}, not the agreed ${formatEther(legPlan[iLeg].amount)}`;
    if (iConfirmed.timeout < responderTimeout + CLAIM_MARGIN_S)
      return "its timeout leaves you too little claim window";
    return null;
  }, [iConfirmed, iLeg, iCfg.asset, legPlan, responderTimeout]);

  // Maker-side verification of the taker's lock before revealing the
  // secret, against the same confirmation-depth snapshot.
  const responderLockIssue = useMemo(() => {
    if (!rConfirmed || rConfirmed.status !== SwapStatus.Open) return null;
    if (!sameAddr(rConfirmed.recipient, legPlan[rLeg].recipient))
      return "its recipient is not your address";
    if (rConfirmed.amount !== legPlan[rLeg].amount)
      return `it escrows ${formatEther(rConfirmed.amount)} ${rCfg.asset}, not the agreed ${formatEther(legPlan[rLeg].amount)}`;
    return null;
  }, [rConfirmed, rLeg, rCfg.asset, legPlan]);

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

  if (!hashlock || initiatorTimeout === null || responderTimeout === null) {
    return null;
  }

  const lockLeg = (leg: LegKey) =>
    runAction(`lock-${leg}`, async () => {
      const plan = legPlan[leg];
      await sendOnLeg(leg, buildLockNativeData(hashlock, plan.recipient, timeoutOf(leg)), plan.amount);
    });

  const claimLeg = (leg: LegKey, preimage: string) =>
    runAction(`claim-${leg}`, async () => {
      await sendOnLeg(leg, buildClaimData(hashlock, preimage), 0n);
    });

  const refundLeg = (leg: LegKey) =>
    runAction(`refund-${leg}`, async () => {
      await sendOnLeg(leg, buildRefundData(hashlock), 0n);
    });

  const revealedPreimage = rState && rState.preimage !== ZERO32 ? rState.preimage : null;

  const who = (ownStep: boolean) => (ownStep ? "You" : "The counterparty");

  const steps = [
    {
      title: `Lock ${iCfg.asset} on ${iCfg.name}`,
      desc: `${who(mySteps[0])} (initiator) escrow${mySteps[0] ? "" : "s"} ${formatEther(legPlan[iLeg].amount)} ${iCfg.asset} under the hashlock. Refundable after ${new Date(initiatorTimeout * 1000).toLocaleTimeString()}.`,
      own: mySteps[0],
      done: Boolean(iState && iState.status !== SwapStatus.None),
      canRun: Boolean(iState && iState.status === SwapStatus.None),
      action: () => lockLeg(iLeg),
      busyKey: `lock-${iLeg}`,
      label: `Lock ${iCfg.asset}`,
      issue: null as string | null,
      pending: null as string | null,
    },
    {
      title: `Lock ${rCfg.asset} on ${rCfg.name}`,
      desc: `${who(mySteps[1])} (responder) verif${mySteps[1] ? "y" : "ies"} the initiator lock on-chain, then escrow${mySteps[1] ? "" : "s"} ${formatEther(legPlan[rLeg].amount)} ${rCfg.asset} under the same hashlock with the shorter timeout.`,
      own: mySteps[1],
      done: Boolean(rState && rState.status !== SwapStatus.None),
      canRun: Boolean(
        iConfirmed &&
          iConfirmed.status === SwapStatus.Open &&
          !initiatorLockIssue &&
          rState &&
          rState.status === SwapStatus.None &&
          nowS < responderTimeout,
      ),
      action: () => lockLeg(rLeg),
      busyKey: `lock-${rLeg}`,
      label: `Lock ${rCfg.asset}`,
      issue: mySteps[1] ? initiatorLockIssue : null,
      pending:
        !rState || rState.status !== SwapStatus.None || !awaitingDepth(iState, iConfirmed)
          ? null
          : `Initiator lock detected on ${iCfg.name}; waiting for ${iCfg.confirmations}-block confirmation depth before it is safe to respond.`,
    },
    {
      title: `Claim ${rCfg.asset} (reveals the secret)`,
      desc: `${who(mySteps[2])} (initiator) claim${mySteps[2] ? "" : "s"} the responder leg. The preimage becomes public on-chain; from here the swap can only complete.`,
      own: mySteps[2],
      done: Boolean(rState && rState.status === SwapStatus.Claimed),
      canRun: Boolean(
        swap.preimage &&
          rConfirmed &&
          rConfirmed.status === SwapStatus.Open &&
          !responderLockIssue &&
          nowS < responderTimeout,
      ),
      action: () => swap.preimage && claimLeg(rLeg, swap.preimage),
      busyKey: `claim-${rLeg}`,
      label: `Claim ${rCfg.asset}`,
      issue: mySteps[2] ? responderLockIssue : null,
      pending:
        rState?.status === SwapStatus.Claimed || !awaitingDepth(rState, rConfirmed)
          ? null
          : `Responder lock detected on ${rCfg.name}; waiting for ${rCfg.confirmations}-block confirmation depth before the secret is safe to reveal.`,
    },
    {
      title: `Claim ${iCfg.asset} with the revealed secret`,
      desc: `${who(mySteps[3])} read${mySteps[3] ? "" : "s"} the now-public preimage from the other chain and claim${mySteps[3] ? "" : "s"} the initiator leg. No trust required at any point.`,
      own: mySteps[3],
      done: Boolean(iState && iState.status === SwapStatus.Claimed),
      canRun: Boolean(
        revealedPreimage && iState && iState.status === SwapStatus.Open && nowS < initiatorTimeout,
      ),
      action: () => revealedPreimage && claimLeg(iLeg, revealedPreimage),
      busyKey: `claim-${iLeg}`,
      label: `Claim ${iCfg.asset}`,
      issue: null,
      pending: null,
    },
  ];

  const complete = iState?.status === SwapStatus.Claimed && rState?.status === SwapStatus.Claimed;

  // You can only refund a leg you initiated: refund() pays the locker.
  const myLegs: LegKey[] =
    swap.role === "maker" ? [iLeg] : swap.role === "taker" ? [rLeg] : [iLeg, rLeg];
  const refundables = myLegs.filter(
    (leg) => legs[leg]?.status === SwapStatus.Open && nowS >= timeoutOf(leg),
  );

  const ownEth = addrOn("eth", swap.role === "taker" ? "taker" : "maker");
  const ownQrl = addrOn("qrl", swap.role === "taker" ? "taker" : "maker");
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
                  : step.own && step.canRun
                    ? "border-blue-accent/60 text-blue-accent"
                    : "border-border text-muted-foreground",
              )}
            >
              {step.done ? <Check className="h-3.5 w-3.5" /> : i + 1}
            </div>
            <div className="flex-1 space-y-1">
              <h3 className="text-sm font-medium">{step.title}</h3>
              <p className="text-xs leading-relaxed text-muted-foreground">{step.desc}</p>
              {step.issue ? (
                <p className="text-xs text-red-400">
                  Not safe to proceed: the counterparty lock failed verification, {step.issue}.
                </p>
              ) : null}
              {!step.done && !step.issue && step.pending ? (
                <p className="text-xs text-amber-400">{step.pending}</p>
              ) : null}
              {!step.done &&
                (step.own ? (
                  <Button
                    size="sm"
                    className="mt-1"
                    disabled={!step.canRun || busy !== null}
                    onClick={step.action}
                  >
                    {busy === step.busyKey ? "Waiting for wallet…" : step.label}
                  </Button>
                ) : step.canRun ? (
                  <p className="text-xs text-blue-accent">Waiting for the counterparty…</p>
                ) : null)}
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
