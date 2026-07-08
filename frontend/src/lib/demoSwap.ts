// Local persistence for the in-flight demo swap. The preimage is
// safety-critical state: losing it after the counterparty locked means
// waiting out the refund path, so it stays in localStorage until the swap
// reaches a terminal state on both legs.

import type { LegKey } from "../config";

export interface DemoSwap {
  direction: "eth->qrl" | "qrl->eth";
  preimage: string;
  hashlock: string;
  /** amounts in wei/planck (both assets use 18 decimals), decimal strings */
  fromAmount: string;
  toAmount: string;
  ethAccount: string;
  qrlAccount: string;
  /** unix seconds */
  initiatorTimeout: number;
  responderTimeout: number;
  createdAt: number;
}

const KEY = "quantaswap.demo.v1";

export const initiatorLeg = (s: DemoSwap): LegKey => (s.direction === "eth->qrl" ? "eth" : "qrl");
export const responderLeg = (s: DemoSwap): LegKey => (s.direction === "eth->qrl" ? "qrl" : "eth");

export function loadDemoSwap(): DemoSwap | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as DemoSwap) : null;
  } catch {
    return null;
  }
}

export function saveDemoSwap(swap: DemoSwap): void {
  localStorage.setItem(KEY, JSON.stringify(swap));
}

export function clearDemoSwap(): void {
  localStorage.removeItem(KEY);
}
