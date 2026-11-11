import { useEffect, useRef } from "react";

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
  /** Seconds the step must have been actionable before it starts by itself. */
  holdS: number;
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
  /** Keys of steps that are inside their hold window. */
  onHolding: (keys: readonly string[]) => void;
}

/** A step that has waited this long without starting is left to the button. */
export const AUTO_START_EXPIRY_S = 600;

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
  const reported = useRef("");

  const fire = () => {
    const { candidates: now, busy: busyNow, nowS: clock } = latest.current;
    if (busyNow !== null || !foreground()) return;
    const next = now.find((c) => {
      const since = waiting.current.get(c.key);
      return since !== undefined && !c.blocked && clock - since >= c.holdS;
    });
    if (next === undefined) return;
    waiting.current.delete(next.key);
    started.current.add(next.key);
    next.run();
  };

  useEffect(() => {
    latest.current = { candidates, busy, nowS };
    // A step the user started by hand is never auto-started afterwards.
    for (const c of candidates) {
      if (busy === c.busyKey) {
        started.current.add(c.key);
        waiting.current.delete(c.key);
      }
    }
    if (ready) {
      const current = new Set(candidates.map((c) => c.key));
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
    const holding = candidates
      .filter((c) => {
        const since = waiting.current.get(c.key);
        return since !== undefined && c.holdS > 0 && nowS - since < c.holdS;
      })
      .map((c) => c.key);
    const signature = holding.join(",");
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
