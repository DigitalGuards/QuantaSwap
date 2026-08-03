// Verdict derivation for the public /swap/<hashlock> permalink page.
// Pure over the two on-chain leg snapshots so the whole matrix is
// unit-testable; the page does the IO. A snapshot is null when its RPC
// could not be reached (fail closed into a partial verdict, never a
// confident one).

import { SwapStatus, type LegState } from "./htlc";

export type LegSnapshot = LegState | null;

export interface SwapVerdict {
  headline: string;
  detail: string;
  tone: "success" | "pending" | "neutral" | "warn";
}

export const HASHLOCK_RE = /^0x[0-9a-fA-F]{64}$/;

const statusOf = (s: LegSnapshot): number | null => (s === null ? null : s.status);

export function deriveVerdict(qrl: LegSnapshot, eth: LegSnapshot): SwapVerdict {
  const a = statusOf(qrl);
  const b = statusOf(eth);

  if (a === null || b === null) {
    const down = a === null && b === null ? "either chain" : a === null ? "QRL v2" : "Sepolia";
    return {
      headline: "Status incomplete",
      detail: `Could not read ${down} right now; this page keeps retrying.`,
      tone: "neutral",
    };
  }

  const both = (s: number) => a === s && b === s;
  const has = (s: number) => a === s || b === s;

  if (both(SwapStatus.Claimed)) {
    return {
      headline: "Atomic swap complete on both chains",
      detail: "Both escrows were claimed with the same secret.",
      tone: "success",
    };
  }
  if (has(SwapStatus.Claimed) && has(SwapStatus.Open)) {
    return {
      headline: "Secret revealed; final claim pending",
      detail:
        "One leg is claimed, so the preimage is public on-chain. The remaining escrow can be claimed by anyone for its fixed recipient before its timeout.",
      tone: "pending",
    };
  }
  if (has(SwapStatus.Claimed) && has(SwapStatus.Refunded)) {
    return {
      headline: "Settled unevenly",
      detail: "One leg was claimed and the other refunded; a claim missed its window.",
      tone: "warn",
    };
  }
  if (has(SwapStatus.Claimed)) {
    return {
      headline: "One leg claimed",
      detail: "The other leg was never escrowed under this hashlock.",
      tone: "warn",
    };
  }
  if (both(SwapStatus.Open)) {
    return {
      headline: "Both legs escrowed",
      detail: "Waiting for the first claim to reveal the secret.",
      tone: "pending",
    };
  }
  if (has(SwapStatus.Open) && has(SwapStatus.Refunded)) {
    return {
      headline: "One leg refunded",
      detail: "The remaining escrow refunds to its initiator after its own timeout.",
      tone: "warn",
    };
  }
  if (has(SwapStatus.Open)) {
    return {
      headline: "One leg escrowed",
      detail: "Waiting for the counterparty to lock the other leg.",
      tone: "pending",
    };
  }
  if (has(SwapStatus.Refunded)) {
    return {
      headline: "Swap expired",
      detail: both(SwapStatus.Refunded)
        ? "Both escrows were refunded."
        : "The escrowed leg was refunded; the other was never locked.",
      tone: "neutral",
    };
  }
  return {
    headline: "No swap found for this hash",
    detail: "Neither chain has an escrow under this hashlock. It may not be locked yet.",
    tone: "neutral",
  };
}
