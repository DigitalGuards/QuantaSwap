import { useEffect, useMemo, useRef, useState } from "react";
import type { LegKey } from "@/config";
import { getSwapEvents, swapEventsNotBeforeS, type LegState, type SwapEvent } from "@/lib/htlc";

/** How long a failed lookup waits before it is tried again. The wait doubles
 *  with every further failure in a row, up to SWAP_EVENTS_RETRY_MAX_MS. */
export const SWAP_EVENTS_RETRY_MS = 15_000;
export const SWAP_EVENTS_RETRY_MAX_MS = 300_000;

/** What a lookup needs to know about a leg. `recipient` is part of it because
 *  assign() names the recipient of an open lock and leaves its status and
 *  timeout as they were. */
type KnownLeg = Pick<LegState, "status" | "timeout" | "recipient">;
type LegReading = KnownLeg | null | undefined;

interface KnownLegs {
  hashlock: string | null;
  qrl: KnownLeg | null;
  eth: KnownLeg | null;
}

const LEGS: readonly LegKey[] = ["qrl", "eth"];

type SwapEventsByLeg = Record<LegKey, SwapEvent[]>;
const NO_LEG_EVENTS: SwapEvent[] = [];

/**
 * The last reading each leg gave for this swap. A failed read (null or
 * undefined) tells nothing new, so the reading before it stays, and a new
 * snapshot object with the same values is the same reading. Returns
 * `previous` itself when nothing changed.
 */
function rememberLegs(
  previous: KnownLegs,
  hashlock: string | null,
  legs: Partial<Record<LegKey, LegReading>>,
): KnownLegs {
  let next: KnownLegs =
    previous.hashlock === hashlock ? previous : { hashlock, qrl: null, eth: null };
  for (const leg of LEGS) {
    const reading = legs[leg];
    if (reading === null || reading === undefined) continue;
    const known = next[leg];
    if (
      known !== null &&
      known.status === reading.status &&
      known.timeout === reading.timeout &&
      known.recipient === reading.recipient
    ) {
      continue;
    }
    next = {
      ...next,
      [leg]: { status: reading.status, timeout: reading.timeout, recipient: reading.recipient },
    };
  }
  return next;
}

/** The events of one leg. See useSwapEvents for when it looks them up. */
function useLegEvents(
  leg: LegKey,
  hashlock: string | null,
  known: KnownLeg | null,
  enabled: boolean,
): SwapEvent[] {
  const [found, setFound] = useState<{ hashlock: string | null; events: SwapEvent[] }>({
    hashlock,
    events: NO_LEG_EVENTS,
  });
  const [retry, setRetry] = useState(0);
  const failures = useRef(0);
  const lastChange = useRef("");
  const queue = useRef<{ hashlock: string | null; tail: Promise<unknown> }>({
    hashlock,
    tail: Promise.resolve(),
  });
  const status = known?.status;
  const recipient = known?.recipient;
  // The events of a leg come after its own lock, so its own lock bounds the
  // scan. Null while the leg holds no lock: there is nothing to look up.
  const notBeforeS = swapEventsNotBeforeS([known]);

  useEffect(() => {
    if (!enabled || hashlock === null || notBeforeS === null) return undefined;
    // New chain state is new information, so the retry wait starts over.
    const change = `${hashlock}|${String(status)}|${recipient ?? ""}|${notBeforeS.toString()}`;
    if (lastChange.current !== change) {
      lastChange.current = change;
      failures.current = 0;
    }
    // Lookups of one swap run one after the other. A different swap starts
    // its own line, so it does not wait for the scan of the swap before it.
    if (queue.current.hashlock !== hashlock) {
      queue.current = { hashlock, tail: Promise.resolve() };
    }
    const run = { alive: true };
    const isAlive = (): boolean => run.alive;
    let timer: ReturnType<typeof setTimeout> | undefined;
    queue.current.tail = queue.current.tail.then(async () => {
      if (!isAlive()) return;
      try {
        const events = await getSwapEvents(leg, hashlock, notBeforeS);
        failures.current = 0;
        if (isAlive()) setFound({ hashlock, events });
      } catch {
        if (!isAlive()) return;
        const wait = Math.min(
          SWAP_EVENTS_RETRY_MS * 2 ** failures.current,
          SWAP_EVENTS_RETRY_MAX_MS,
        );
        failures.current += 1;
        timer = setTimeout(() => setRetry((count) => count + 1), wait);
      }
    });
    return () => {
      run.alive = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [enabled, leg, hashlock, notBeforeS, status, recipient, retry]);

  return found.hashlock === hashlock ? found.events : NO_LEG_EVENTS;
}

/**
 * The explorer-link events of one swap, looked up from the HTLCs' own logs.
 *
 * A leg is looked up when its status or its recipient changes, and again
 * after a failed lookup, with a wait that doubles up to five minutes. A poll
 * tick that changes nothing starts no lookup, and neither does a leg state
 * read that failed. Each leg is looked up on its own, one lookup at a time,
 * and a failed lookup keeps the events that leg already had. Events belong
 * to one hashlock: a different swap starts empty.
 *
 * The scan bound of a leg comes from its own lock (swapEventsNotBeforeS), so
 * no local record is needed. A leg that holds no lock is not asked.
 */
export function useSwapEvents(
  hashlock: string | null,
  legs: Partial<Record<LegKey, LegReading>>,
  enabled = true,
): SwapEventsByLeg {
  const [remembered, setRemembered] = useState<KnownLegs>({ hashlock, qrl: null, eth: null });
  // State adjusted while rendering: React renders again at once with the new
  // value, and `known` is already right for this pass.
  const known = rememberLegs(remembered, hashlock, legs);
  if (known !== remembered) setRemembered(known);

  const qrl = useLegEvents("qrl", hashlock, known.qrl, enabled);
  const eth = useLegEvents("eth", hashlock, known.eth, enabled);
  return useMemo(() => ({ qrl, eth }), [qrl, eth]);
}
