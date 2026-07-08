import { useCallback, useEffect, useMemo, useState } from "react";
import { formatEther } from "ethers";
import type { BrowserProvider } from "ethers";
import { ETH_LEG, QRL_LEG, legByKey } from "../config";
import type { LegKey } from "../config";
import {
  SwapStatus,
  buildClaimData,
  buildLockNativeData,
  buildRefundData,
  getLegState,
  type LegState,
} from "../lib/htlc";
import { initiatorLeg, responderLeg, type DemoSwap } from "../lib/demoSwap";

const ZERO32 = `0x${"0".repeat(64)}`;

interface Props {
  swap: DemoSwap;
  browserProvider: BrowserProvider | null;
  ensureSepolia: () => Promise<void>;
  qrlRequest: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  onDiscard: () => void;
}

type LegStates = Partial<Record<LegKey, LegState>>;

const statusName = ["none", "open", "claimed", "refunded"] as const;

function StatusPill({ state }: { state: LegState | undefined }) {
  const name = state ? statusName[state.status] : "none";
  return <span className={`status-pill ${name ?? "none"}`}>{state ? (statusName[state.status] ?? "none") : "…"}</span>;
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
    <div className="card">
      <h2>
        Swap in progress
        <span className="status-pill none mono" style={{ marginLeft: 10 }}>
          {swap.hashlock.slice(0, 14)}…
        </span>
      </h2>
      {complete ? <div className="success-banner">Atomic swap complete on both chains</div> : null}
      <p className="muted" style={{ marginTop: 0 }}>
        {iCfg.name} leg <StatusPill state={iState} /> · {rCfg.name} leg <StatusPill state={rState} />
      </p>

      {steps.map((step, i) => (
        <div key={step.title} className={`step ${step.done ? "done" : step.canRun ? "active" : ""}`}>
          <div className="idx">{step.done ? "✓" : i + 1}</div>
          <div className="body">
            <h3>{step.title}</h3>
            <p>{step.desc}</p>
            {!step.done && (
              <button
                className="btn small"
                disabled={!step.canRun || busy !== null}
                onClick={step.action}
              >
                {busy === step.busyKey ? "Waiting for wallet…" : step.label}
              </button>
            )}
          </div>
        </div>
      ))}

      {refundables.length > 0 && !complete ? (
        <div style={{ marginTop: 14 }}>
          {refundables.map((leg) => (
            <button
              key={leg}
              className="btn small danger"
              style={{ marginRight: 8 }}
              disabled={busy !== null}
              onClick={() => refundLeg(leg)}
            >
              Refund {legByKey(leg).asset} leg
            </button>
          ))}
        </div>
      ) : null}

      {error ? <div className="error">{error}</div> : null}

      <div className="field-note" style={{ marginTop: 16 }}>
        <button className="reveal" onClick={() => setShowSecret((v) => !v)}>
          {showSecret ? "Hide secret" : "Reveal secret (stays in this browser)"}
        </button>
        <button
          className="reveal"
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
        </button>
      </div>
      {showSecret ? <div className="mono muted" style={{ marginTop: 6, wordBreak: "break-all" }}>{swap.preimage}</div> : null}
    </div>
  );
}
