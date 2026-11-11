import { useEffect, useRef } from "react";

export interface AutoStartCandidate {
  /** Step key; one automatic start per key for the life of this component. */
  key: string;
  /** The busy-state key of the step's own action, to notice a manual start. */
  busyKey: string;
  /** The step's existing action, the same function its button calls. */
  run: () => void;
  /** An own transaction for this step is already awaited. */
  blocked: boolean;
}

interface Props {
  /** Own steps that are actionable apart from busy and a pending own
   *  transaction. Refund, release, discard and credit actions never go here. */
  candidates: readonly AutoStartCandidate[];
  /** Chain state has loaded, so the first reading is a trustworthy baseline. */
  ready: boolean;
  busy: string | null;
}

const foreground = (): boolean => document.visibilityState === "visible" && document.hasFocus();

/**
 * Starts an own step's action once when the mounted swap screen sees that
 * step turn actionable, so the wallet opens without a button press. The
 * button stays the retry: a step is never auto-started twice, and a step
 * that was already actionable on the first loaded reading is only a baseline
 * (opening a swap link must not pop a wallet). Mount it with `key={hashlock}`
 * so a different swap starts fresh. Renders nothing.
 */
export function AutoStartSteps({ candidates, ready, busy }: Props) {
  const latest = useRef({ candidates, busy });
  const previous = useRef<ReadonlySet<string> | null>(null);
  const started = useRef(new Set<string>());
  const waiting = useRef(new Set<string>());

  const fire = () => {
    const { candidates: now, busy: busyNow } = latest.current;
    if (busyNow !== null || !foreground()) return;
    const next = now.find((c) => waiting.current.has(c.key) && !c.blocked);
    if (next === undefined) return;
    waiting.current.delete(next.key);
    started.current.add(next.key);
    next.run();
  };

  useEffect(() => {
    latest.current = { candidates, busy };
    // A step the user started by hand is never auto-started afterwards.
    for (const c of candidates) {
      if (busy === c.busyKey) {
        started.current.add(c.key);
        waiting.current.delete(c.key);
      }
    }
    if (!ready) return;
    const current = new Set(candidates.map((c) => c.key));
    const before = previous.current;
    previous.current = current;
    if (before === null) return;
    for (const key of waiting.current) if (!current.has(key)) waiting.current.delete(key);
    for (const key of current) {
      if (!before.has(key) && !started.current.has(key)) waiting.current.add(key);
    }
    fire();
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
