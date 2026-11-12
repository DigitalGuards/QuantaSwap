import { useEffect, useState } from "react";
import type { LegKey } from "@/config";
import { getChainClockReading, getTxSender } from "@/lib/htlc";

/** A failed lookup waits this long before it is tried again. */
export const CHAIN_READ_RETRY_MS = 15_000;
const CHAIN_READ_ATTEMPTS = 5;

export interface ClockReading {
  /** Age of the reveal block on the chain's own clock. */
  ageS: number;
  /** Newest block time of the leg the claim pays out from. */
  claimHeadS: number;
  /** The page clock (unix seconds) when the reading finished. */
  readAtS: number;
}

/**
 * Runs one chain lookup per key, retried a few times on failure. A failed
 * lookup leaves the caller with its fallback and never with a stale answer.
 */
function useLookup<T>(key: string | null, run: () => Promise<T>): T | undefined {
  const [found, setFound] = useState<{ key: string; value: T } | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (key === null || found?.key === key) return undefined;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    run().then(
      (value) => {
        if (alive) setFound({ key, value });
      },
      () => {
        if (alive && retry + 1 < CHAIN_READ_ATTEMPTS) {
          timer = setTimeout(() => setRetry((n) => n + 1), CHAIN_READ_RETRY_MS);
        }
      },
    );
    return () => {
      alive = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [key, found, retry]);

  return key !== null && found?.key === key ? found.value : undefined;
}

/**
 * How old the secret reveal is and where the claim leg's clock stands, both
 * from the chains. The hold window runs in page time from these, so a wrong
 * device clock cannot lengthen or shorten it.
 */
export function useChainClock(
  revealLeg: LegKey,
  revealBlock: number | null,
  claimLeg: LegKey,
): ClockReading | undefined {
  const key = revealBlock === null ? null : `${revealLeg}:${String(revealBlock)}:${claimLeg}`;
  return useLookup(key, async () => {
    const reading = await getChainClockReading(revealLeg, revealBlock ?? 0, claimLeg);
    return { ...reading, readAtS: Math.floor(Date.now() / 1000) };
  });
}

/** The sender of one transaction, or undefined while unknown. */
export function useTxSender(leg: LegKey, txHash: string | null): string | null | undefined {
  return useLookup(txHash === null ? null : `${leg}:${txHash}`, () =>
    getTxSender(leg, txHash ?? ""),
  );
}
