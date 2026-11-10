import { useEffect, useRef, useState } from "react";
import type { LegKey } from "@/config";
import {
  getSwapEvents,
  swapEventsNotBeforeS,
  SwapStatus,
  type LegState,
  type SwapEvent,
} from "@/lib/htlc";

/** How long a failed lookup waits before it is tried again. */
export const SWAP_EVENTS_RETRY_MS = 15_000;

type LegReading = Pick<LegState, "status" | "timeout"> | null | undefined;

const LEGS: readonly LegKey[] = ["qrl", "eth"];

/**
 * The explorer-link events of one swap, looked up from the HTLCs' own logs.
 * A leg is looked up when its status changes and again after a failed
 * lookup, never on every poll tick. Lookups for one leg run one at a time,
 * and a failed lookup keeps the events that leg already had.
 *
 * The scan bound comes from the legs' own locks (swapEventsNotBeforeS), so no
 * local record is needed. A leg that holds no lock is not asked.
 */
export function useSwapEvents(
  hashlock: string | null,
  legs: Partial<Record<LegKey, LegReading>>,
  enabled = true,
): Record<LegKey, SwapEvent[]> {
  const [events, setEvents] = useState<Record<LegKey, SwapEvent[]>>({ qrl: [], eth: [] });
  const [retry, setRetry] = useState(0);
  const inflight = useRef<Record<LegKey, Promise<unknown>>>({
    qrl: Promise.resolve(),
    eth: Promise.resolve(),
  });
  const qrlStatus = legs.qrl?.status;
  const ethStatus = legs.eth?.status;
  const notBeforeS = swapEventsNotBeforeS([legs.qrl, legs.eth]);

  useEffect(() => {
    if (!enabled || hashlock === null || notBeforeS === null) return undefined;
    const run = { alive: true };
    const isAlive = (): boolean => run.alive;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wanted = LEGS.filter((leg) => {
      const status = leg === "qrl" ? qrlStatus : ethStatus;
      return status !== undefined && status !== SwapStatus.None;
    });
    for (const leg of wanted) {
      inflight.current[leg] = inflight.current[leg].then(async () => {
        if (!isAlive()) return;
        try {
          const list = await getSwapEvents(leg, hashlock, notBeforeS);
          if (isAlive()) setEvents((previous) => ({ ...previous, [leg]: list }));
        } catch {
          if (isAlive() && timer === undefined) {
            timer = setTimeout(() => setRetry((count) => count + 1), SWAP_EVENTS_RETRY_MS);
          }
        }
      });
    }
    return () => {
      run.alive = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [enabled, hashlock, notBeforeS, qrlStatus, ethStatus, retry]);

  return events;
}
