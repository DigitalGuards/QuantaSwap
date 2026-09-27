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
  /** This browser's own role is the credited account, so the panel can say
   *  whose payout it is. Moving it still needs the wallet that holds it: see
   *  creditExit(). */
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
 * Every payee a settlement of this swap could have credited: per leg, the
 * recipient a claim pays and the initiator a refund or release pays. Both
 * legs and both parties are polled whichever side this browser plays. Own
 * payouts are the point, and a counterparty payout matters too: anyone can
 * push a credit to the account that owns it, which is what finishes a
 * deferred payout for a counterparty holding no gas on that chain.
 */
export function creditCandidates(machine: SwapMachine): CreditCandidate[] {
  const candidates: CreditCandidate[] = [];
  const seen = new Set<string>();
  const ownOn = (leg: LegKey): string => (leg === "eth" ? machine.ownEth : machine.ownQrl);
  for (const leg of [machine.iLeg, machine.rLeg]) {
    const plan = machine.legPlan[leg];
    const payees = machine.legPayees[leg];
    for (const account of [payees.claim, payees.refund]) {
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
 * The exit available for one credit from this browser. `withdraw` reads
 * `msg.sender`, so only the wallet that holds the credit can name a
 * destination; every other signer, including this user on a different wallet,
 * is left with the permissionless push, which pays the credited account
 * itself and gains nobody any redirect authority. `connected` is the wallet
 * currently attached on that leg, or null when none is.
 */
export const creditExit = (
  view: CreditView,
  connected: string | null,
): "withdraw" | "push" =>
  connected !== null && sameAddr(connected, view.account) ? "withdraw" : "push";
