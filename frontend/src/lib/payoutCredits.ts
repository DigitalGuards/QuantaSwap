// Pure derivation of the HTLCv3 payout-credit view. A settled swap is
// terminal whether or not its payout was delivered: when delivery fails,
// HTLCv3 keeps the amount as a credit owned by the payee the fund owner
// chose. `Claimed` therefore no longer implies "funds received"
// (docs/audit/HTLCV3_SCOPE.md A13), so the browser reads creditOf() for
// every payee of this swap and offers the two exits the contract has.
// No IO here; SwapFlow polls the amounts and renders what this returns.

import { formatUnits } from "ethers";
import type { LegKey } from "../config";
import { sameAddr, type SwapMachine } from "./swapMachine";

/** One (leg, token, account) the browser polls creditOf() for. */
export interface CreditCandidate {
  leg: LegKey;
  /** Native sentinel for a native leg, the registry ERC-20 otherwise. */
  token: string;
  /** The credited account. Only this account can redirect its credit. */
  account: string;
  symbol: string;
  decimals: number;
  /** The connected wallet on this leg is the credited account. */
  own: boolean;
}

export interface CreditView extends CreditCandidate {
  amount: bigint;
  display: string;
}

/** Stable key for a candidate, also the key of the polled amount map. */
export const creditKey = (leg: LegKey, token: string, account: string): string =>
  `${leg}:${token.toLowerCase()}:${account.toLowerCase()}`;

/**
 * Every payee a settlement of this swap could have credited: each leg's
 * claim payee (the recipient fixed at lock time) and each leg's refund
 * payee (this browser's own address, since refund() pays the locker). Both
 * legs are polled whichever side this browser plays, because a maker that
 * sponsors the taker's claim needs to see a credit owed to the taker in
 * order to push it.
 */
export function creditCandidates(machine: SwapMachine): CreditCandidate[] {
  const candidates: CreditCandidate[] = [];
  const seen = new Set<string>();
  const ownOn = (leg: LegKey): string => (leg === "eth" ? machine.ownEth : machine.ownQrl);
  for (const leg of [machine.iLeg, machine.rLeg]) {
    const plan = machine.legPlan[leg];
    for (const account of [plan.recipient, ownOn(leg)]) {
      if (account === "") continue;
      const key = creditKey(leg, plan.expectedToken, account);
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({
        leg,
        token: plan.expectedToken,
        account,
        symbol: plan.symbol,
        decimals: plan.decimals,
        own: sameAddr(account, ownOn(leg)),
      });
    }
  }
  return candidates;
}

/** The candidates that actually hold a credit, in polling order. */
export function creditViews(
  candidates: readonly CreditCandidate[],
  amounts: ReadonlyMap<string, bigint>,
): CreditView[] {
  const views: CreditView[] = [];
  for (const candidate of candidates) {
    const amount = amounts.get(creditKey(candidate.leg, candidate.token, candidate.account));
    if (amount === undefined || amount <= 0n) continue;
    views.push({
      ...candidate,
      amount,
      display: `${formatUnits(amount, candidate.decimals)} ${candidate.symbol}`,
    });
  }
  return views;
}

/**
 * The exit available for one credit. A credited account withdraws to any
 * destination it names; anyone else can only push the credit to the account
 * itself, which is what lets a sponsor finish a payout for a taker who
 * holds no gas on that chain, without gaining any redirect authority.
 */
export const creditAction = (view: CreditView): "withdraw" | "push" =>
  view.own ? "withdraw" : "push";
