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
 * Runs one chain lookup per key, retried a few times on failure. A lookup
 * that answers null counts as a failed attempt too (a node can lag the logs
 * endpoint by a block). Retries are counted per key. A failed lookup leaves
 * the caller with its fallback and never with a stale answer.
 */
function useLookup<T>(key: string | null, run: () => Promise<T | null>): T | undefined {
  const [found, setFound] = useState<{ key: string; value: T } | null>(null);
  const [retry, setRetry] = useState<{ key: string; count: number }>({ key: "", count: 0 });
  const attempts = retry.key === key ? retry.count : 0;

  useEffect(() => {
    if (key === null || found?.key === key) return undefined;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const again = () => {
      if (alive && attempts + 1 < CHAIN_READ_ATTEMPTS) {
        timer = setTimeout(() => setRetry({ key, count: attempts + 1 }), CHAIN_READ_RETRY_MS);
      }
    };
    run().then((value) => {
      if (!alive) return;
      if (value === null) again();
      else setFound({ key, value });
    }, again);
    return () => {
      alive = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [key, found, attempts]);

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
export function useTxSender(leg: LegKey, txHash: string | null): string | undefined {
  return useLookup(txHash === null ? null : `${leg}:${txHash}`, () =>
    getTxSender(leg, txHash ?? ""),
  );
}
