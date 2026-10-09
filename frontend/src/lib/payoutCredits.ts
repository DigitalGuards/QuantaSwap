// Pure derivation of the HTLCv3 payout-credit view. A settled swap is
// terminal whether or not its payout was delivered: when delivery fails,
// HTLCv3 keeps the amount as a credit owned by the payee the fund owner
// chose. `Claimed` therefore no longer implies "funds received"
// (docs/audit/HTLCV3_SCOPE.md A13), so the browser reads creditOf() for
// every payee of this swap and offers the two exits the contract has.
// No IO here; SwapFlow polls the amounts and renders what this returns.

import { formatUnits } from "ethers";
import type { LegKey } from "../config";
import type { CreditReading } from "./htlc";
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
  /** What THIS swap still owes this account: the smaller of what its
   *  settlement credited and what the shared ledger still holds. */
  amount: bigint;
  display: string;
  /** The rest of this account's ledger balance in this token, left by other
   *  swaps. Shown separately and labelled, because this page can say nothing
   *  about where it came from. */
  otherSwaps: bigint;
  otherSwapsDisplay: string;
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

/**
 * The candidates this swap actually left a credit for, in polling order.
 * A ledger balance with no PayoutCredited log for this hashlock belongs to
 * another swap: this page cannot say anything true about it, and it must
 * never be offered a Push here, so it is left out of the list and only
 * reported as the labelled remainder on an entry this swap does own.
 */
export function creditViews(
  candidates: readonly CreditCandidate[],
  readings: ReadonlyMap<string, CreditReading>,
): CreditView[] {
  const views: CreditView[] = [];
  for (const candidate of candidates) {
    const reading = readings.get(creditKey(candidate.leg, candidate.token, candidate.account));
    if (reading === undefined) continue;
    const amount = reading.credited < reading.global ? reading.credited : reading.global;
    if (amount <= 0n) continue;
    const otherSwaps = reading.global - amount;
    views.push({
      ...candidate,
      amount,
      display: `${formatUnits(amount, candidate.decimals)} ${candidate.symbol}`,
      otherSwaps,
      otherSwapsDisplay: `${formatUnits(otherSwaps, candidate.decimals)} ${candidate.symbol}`,
    });
  }
  return views;
}

/**
 * The exit available for one credit from this browser. `withdraw` reads
 * `msg.sender`, so only the wallet that holds the credit can name a
 * destination; every other signer, including this user on a different wallet,
 * is left with the permissionless push, which pays the credited account
 * itself and gains nobody any redirect authority. With no wallet attached on
 * that leg there is nothing to sign with at all, which is its own state:
 * neither exit is offered and the user is asked to connect.
 */
export const creditExit = (
  view: CreditView,
  connected: string | null,
): "withdraw" | "push" | "connect" =>
  connected === null ? "connect" : sameAddr(connected, view.account) ? "withdraw" : "push";
