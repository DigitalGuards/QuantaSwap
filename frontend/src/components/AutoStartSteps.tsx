import { useEffect, useLayoutEffect, useRef } from "react";
import { CLAIM_MARGIN_S } from "@/config";
import { claimHoldWindow } from "@/lib/swapNowLine";

export interface AutoStartCandidate {
  /** Step key; one automatic start per key for the life of this component. */
  key: string;
  /** The busy-state key of the step's own action, to notice a manual start. */
  busyKey: string;
  /** The step's existing action, the same function its button calls. */
  run: () => void;
  /** Cannot start now (own transaction awaited, wallet missing, account
   *  mismatch). The step keeps its place and starts once this clears. */
  blocked: boolean;
  /** Longest hold, in seconds, before the step starts by itself. */
  holdS: number;
  /** Age of the secret reveal on the chain's own clock, with the page second
   *  it was read. It survives a reload; without it a live step holds for
   *  holdS from the moment this page saw it and a step found on the first
   *  reading only shows a short checking window. */
  holdAge?: { ageS: number; readAtS: number } | undefined;
  /** Seconds left before the leg the step claims from times out, on that
   *  chain's clock. A hold never runs into the claim cutoff. */
  holdTimeLeftS?: number | undefined;
}

/** A step inside its hold window. */
export interface HoldingWindow {
  key: string;
  startS: number;
  endS: number;
  /** The reveal is not dated yet; the window only covers that lookup. */
  checking: boolean;
  /** An automatic start follows the window. */
  auto: boolean;
}

interface Props {
  /** Own steps that are actionable apart from `blocked` and busy. Refund,
   *  release, discard and credit actions never go here. */
  candidates: readonly AutoStartCandidate[];
  /** Chain state and the signed-fill check have settled, so the first
   *  reading is a trustworthy baseline. */
  ready: boolean;
  busy: string | null;
  /** The component's clock, in seconds. */
  nowS: number;
  /** A swap created in this page session: its first reading counts as a
   *  transition, so its first own step opens the wallet. */
  fresh: boolean;
  /** Steps that are inside their hold window. */
  onHolding: (windows: readonly HoldingWindow[]) => void;
}

/** A step that has waited this long without starting is left to the button. */
export const AUTO_START_EXPIRY_S = 600;

const windowOf = (
  c: AutoStartCandidate,
  nowS: number,
  firstSeenS: number | undefined,
  live: boolean,
) =>
  claimHoldWindow({
    holdS: c.holdS,
    claimMarginS: CLAIM_MARGIN_S,
    nowS,
    firstSeenS,
    live,
    age: c.holdAge,
    timeLeftS: c.holdTimeLeftS,
  });

const foreground = (): boolean => document.visibilityState === "visible" && document.hasFocus();

/**
 * Starts an own step's action once when the mounted swap screen sees that
 * step turn actionable, so the wallet opens without a button press. The
 * button stays the retry: a step is never auto-started twice, and a step
 * that was already actionable on the first loaded reading is only a baseline
 * (opening a swap link must not pop a wallet). Renders nothing.
 */
export function AutoStartSteps({ candidates, ready, busy, nowS, fresh, onHolding }: Props) {
  const latest = useRef({ candidates, busy, nowS });
  const previous = useRef<ReadonlySet<string> | null>(null);
  const started = useRef(new Set<string>());
  /** Step key to the second it started waiting. */
  const waiting = useRef(new Map<string, number>());
  /** Step key to the second this page first saw it actionable, for live
   *  transitions and for steps found actionable on the first reading alike. */
  const firstSeen = useRef(new Map<string, number>());
  /** Steps whose Claim button was offered after their window. Never held again. */
  const offered = useRef(new Set<string>());
  const reported = useRef("");

  const fire = () => {
    const { candidates: now, busy: busyNow, nowS: clock } = latest.current;
    if (busyNow !== null || !foreground()) return;
    const next = now.find((c) => {
      const since = waiting.current.get(c.key);
      if (since === undefined || c.blocked) return false;
      const win = windowOf(c, clock, firstSeen.current.get(c.key) ?? since, true);
      return win === null || clock >= win.endS;
    });
    if (next === undefined) return;
    waiting.current.delete(next.key);
    started.current.add(next.key);
    next.run();
  };

  // A layout effect, so the hold is reported before the first paint of a step
  // that just turned actionable: the Claim button never shows for a frame.
  useLayoutEffect(() => {
    latest.current = { candidates, busy, nowS };
    // A step the user started by hand is never auto-started afterwards.
    for (const c of candidates) {
      if (busy === c.busyKey) {
        started.current.add(c.key);
        waiting.current.delete(c.key);
      }
    }
    // When this page first saw a step actionable is a fact about this page
    // session, so it is recorded before the first reading is trusted. The
    // hold can then cover the step from its first paint. Only the automatic
    // start below waits for `ready`.
    // The first sighting is kept for the life of the component, which is
    // keyed by hashlock: a step that drops out and comes back does not start
    // a new hold.
    const seen = new Set(candidates.map((c) => c.key));
    for (const key of seen) {
      if (!firstSeen.current.has(key)) firstSeen.current.set(key, nowS);
    }
    if (ready) {
      const current = seen;
      const before = previous.current ?? (fresh ? new Set<string>() : null);
      previous.current = current;
      if (before !== null) {
        for (const [key, since] of waiting.current) {
          if (!current.has(key) || nowS - since > AUTO_START_EXPIRY_S) waiting.current.delete(key);
        }
        for (const key of current) {
          if (!before.has(key) && !started.current.has(key) && !waiting.current.has(key)) {
            waiting.current.set(key, nowS);
          }
        }
        fire();
      }
    }
    // A step whose hold the chain started is held even when this page only
    // just opened (no automatic start then, but no button during the window).
    const holding = candidates.flatMap((c) => {
      if (started.current.has(c.key) || busy === c.busyKey) return [];
      const live = waiting.current.has(c.key);
      const win = windowOf(c, nowS, firstSeen.current.get(c.key), live);
      if (win === null || nowS >= win.endS) {
        // The window is over (or there is none): the button is offered, and a
        // step whose button was offered is never taken away again.
        offered.current.add(c.key);
        return [];
      }
      return offered.current.has(c.key) ? [] : [{ key: c.key, ...win, auto: live }];
    });
    const signature = holding
      .map(
        (h) =>
          `${h.key}:${String(h.startS)}:${String(h.endS)}:${String(h.checking)}:${String(h.auto)}`,
      )
      .join(",");
    if (signature !== reported.current) {
      reported.current = signature;
      onHolding(holding);
    }
  });

  useEffect(() => {
    const onChange = () => fire();
    document.addEventListener("visibilitychange", onChange);
    window.addEventListener("focus", onChange);
    return () => {
      document.removeEventListener("visibilitychange", onChange);
      window.removeEventListener("focus", onChange);
    };
  }, []);

  return null;
}
