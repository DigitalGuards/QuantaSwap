// A deferred HTLCv3 payout, surfaced outside the swap flow. Release and
// refund settle escrow from the order views (a pre-funded listing is
// reclaimed in the order views, outside SwapFlow), and under HTLCv3 any of those
// can end as a credit the payee still has to collect. Without this panel the
// only record of that credit would be the chain.
//
// Deliberately self-contained: it owns its poll, its wallet sender and its
// error line, so an order view only has to name the escrow it settled.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { BrowserProvider } from "ethers";
import { formatUnits } from "ethers";
import { legByKey, type LegKey } from "@/config";
import {
  buildPushCreditData,
  buildWithdrawAllData,
  readSwapCredit,
  type CreditReading,
} from "@/lib/htlc";
import { makeSettlementSender } from "@/lib/legSender";
import { sameAddr } from "@/lib/swapMachine";
import type { QrlTransport } from "@/hooks/useQrlWallet";
import { AddressFingerprint } from "@/components/AddressFingerprint";
import { Button } from "@/components/UI/Button";
import { errorMessage } from "@/utils/errorMessage";

/** One escrow payout this view is responsible for showing. */
export interface DeferredPayoutTarget {
  /** Stable identity for the poll and the busy key. */
  id: string;
  leg: LegKey;
  /** The swap whose settlement could have credited: PayoutCredited carries
   *  it, which is how a credit is attributed to this escrow and not to the
   *  shared per-address ledger. */
  hashlock: string;
  /** The escrowed asset, which is the credit ledger's key. */
  token: string;
  /** The address the payout was owed to. */
  account: string;
  symbol: string;
  decimals: number;
}

interface Props {
  targets: readonly DeferredPayoutTarget[];
  ethAccount: string | null;
  qrlAccount: string | null;
  browserProvider: BrowserProvider | null;
  ensureSepolia: () => Promise<void>;
  qrlRequest: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  qrlTransport: QrlTransport | null;
  /** Called after a credit provably reached zero, so the caller can retire
   *  whatever local record it was holding open for it. */
  onCleared?: (target: DeferredPayoutTarget) => void;
}

export function DeferredPayoutPanel({
  targets,
  ethAccount,
  qrlAccount,
  browserProvider,
  ensureSepolia,
  qrlRequest,
  qrlTransport,
  onCleared,
}: Props) {
  const [readings, setReadings] = useState<ReadonlyMap<string, CreditReading>>(new Map());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const settleOnLeg = useMemo(
    () =>
      makeSettlementSender({ browserProvider, ensureSepolia, qrlAccount, qrlTransport, qrlRequest }),
    [browserProvider, ensureSepolia, qrlAccount, qrlTransport, qrlRequest],
  );

  const key = targets.map((target) => target.id).join("|");
  const refresh = useCallback(async () => {
    const results = await Promise.allSettled(
      targets.map((target) =>
        readSwapCredit(target.leg, target.token, target.account, target.hashlock),
      ),
    );
    setReadings((previous) => {
      const next = new Map(previous);
      targets.forEach((target, index) => {
        const result = results[index];
        // A failed read keeps the last reading: a credit disappearing from
        // this panel on an RPC hiccup would read as a payout that landed.
        if (result?.status === "fulfilled") next.set(target.id, result.value);
      });
      return next;
    });
    targets.forEach((target, index) => {
      const result = results[index];
      if (result?.status === "fulfilled" && result.value.global === 0n) onCleared?.(target);
    });
    // The target list is identified by `key`, and onCleared is a caller
    // callback whose identity must not restart the poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    if (targets.length === 0) return undefined;
    void refresh();
    const timer = setInterval(() => void refresh(), 6000);
    return () => clearInterval(timer);
  }, [targets.length, refresh]);

  const connectedOn = (leg: LegKey): string | null => (leg === "eth" ? ethAccount : qrlAccount);

  const run = (id: string, action: () => Promise<void>) => {
    setError(null);
    setBusy(id);
    void action()
      .then(refresh)
      .catch((err: unknown) => setError(errorMessage(err)))
      .finally(() => setBusy(null));
  };

  const outstanding = targets.flatMap((target) => {
    const reading = readings.get(target.id);
    if (reading === undefined) return [];
    const amount = reading.credited < reading.global ? reading.credited : reading.global;
    if (amount <= 0n) return [];
    return [{ target, amount, otherSwaps: reading.global - amount }];
  });

  if (outstanding.length === 0) return null;

  return (
    <div
      className="mt-3 space-y-3 rounded-md border border-amber-400/40 bg-amber-400/5 p-3"
      data-testid="deferred-payouts"
    >
      <div className="space-y-1">
        <h3 className="text-sm font-medium text-amber-400">Deferred payout</h3>
        <p className="text-xs leading-relaxed text-muted-foreground">
          The escrow settled, and the payout could not be handed to your address, so the HTLC is
          holding the amount as a credit. It is fully backed and only your address can be paid.
        </p>
      </div>
      {outstanding.map(({ target, amount, otherSwaps }) => {
        const exit = connectedOn(target.leg);
        const own = exit !== null && sameAddr(exit, target.account);
        return (
          <div
            key={target.id}
            className="space-y-1.5 border-t border-border/60 pt-2 first:border-t-0 first:pt-0"
          >
            <dl className="space-y-1 text-xs">
              <div>
                <dt className="inline text-muted-foreground">Amount: </dt>
                <dd className="inline font-medium">
                  {formatUnits(amount, target.decimals)} {target.symbol}
                </dd>
              </div>
              <div>
                <dt className="inline text-muted-foreground">Chain: </dt>
                <dd className="inline">{legByKey(target.leg).name}</dd>
              </div>
              <div>
                <dt className="inline text-muted-foreground">Owed to: </dt>
                <dd className="inline">
                  <AddressFingerprint address={target.account} />
                </dd>
              </div>
              {otherSwaps > 0n ? (
                <div>
                  <dt className="inline text-muted-foreground">Also held for this address: </dt>
                  <dd className="inline">
                    {formatUnits(otherSwaps, target.decimals)} {target.symbol} from other swaps.
                    Moving this credit moves the whole balance, because the contract keeps one
                    ledger per address and asset.
                  </dd>
                </div>
              ) : null}
            </dl>
            {exit === null ? (
              <p className="text-xs text-amber-400">
                Connect a wallet on {legByKey(target.leg).name} to collect this credit.
              </p>
            ) : own ? (
              <Button
                size="sm"
                disabled={busy !== null}
                onClick={() =>
                  run(target.id, async () => {
                    await settleOnLeg(
                      target.leg,
                      buildWithdrawAllData(target.leg, target.token, target.account),
                      0n,
                    );
                  })
                }
              >
                {busy === target.id ? "Waiting for wallet…" : "Collect"}
              </Button>
            ) : (
              <div className="space-y-1.5">
                <Button
                  size="sm"
                  disabled={busy !== null}
                  onClick={() =>
                    run(target.id, async () => {
                      await settleOnLeg(
                        target.leg,
                        buildPushCreditData(target.leg, target.token, target.account),
                        0n,
                      );
                    })
                  }
                >
                  {busy === target.id ? "Waiting for wallet…" : "Pay it to that address"}
                </Button>
                <p className="text-xs text-muted-foreground">
                  The connected wallet is a different address, so it cannot choose a destination.
                  This call takes none and pays the address that owns the credit.
                </p>
              </div>
            )}
          </div>
        );
      })}
      {error ? <p className="text-xs break-words text-destructive">{error}</p> : null}
    </div>
  );
}
