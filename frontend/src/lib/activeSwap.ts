// Local persistence for the in-flight swap. The preimage is safety-critical
// state: losing it after the counterparty locked means waiting out the
// refund path, so it stays in localStorage until the swap reaches a
// terminal state on both legs. The taker never holds the preimage.

import type { LegKey } from "../config";

export type Direction = "eth->qrl" | "qrl->eth";
export type SwapRole = "maker" | "taker" | "sandbox";

export interface ActiveSwap {
  role: SwapRole;
  /** Order book id; null in the sandbox. */
  orderId: string | null;
  /** Maker's perspective: the maker escrows `fromAmount` on the from-chain. */
  direction: Direction;
  /** Wei on the initiator (maker) leg, decimal string. */
  fromAmount: string;
  /** Wei on the responder (taker) leg, decimal string. */
  toAmount: string;
  makerEthAccount: string;
  makerQrlAccount: string;
  takerEthAccount: string;
  takerQrlAccount: string;
  /** Maker/sandbox only. */
  preimage: string | null;
  /** Null on the taker side until the maker announces it. */
  hashlock: string | null;
  initiatorTimeout: number | null;
  responderTimeout: number | null;
  createdAt: number;
}

const KEY = "quantaswap.swap.v2";
const LEGACY_KEY = "quantaswap.demo.v1";

export const initiatorLeg = (direction: Direction): LegKey =>
  direction === "eth->qrl" ? "eth" : "qrl";
export const responderLeg = (direction: Direction): LegKey =>
  direction === "eth->qrl" ? "qrl" : "eth";

interface LegacyDemoSwap {
  direction: Direction;
  preimage: string;
  hashlock: string;
  fromAmount: string;
  toAmount: string;
  ethAccount: string;
  qrlAccount: string;
  initiatorTimeout: number;
  responderTimeout: number;
  createdAt: number;
}

function migrateLegacy(): ActiveSwap | null {
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return null;
    const old = JSON.parse(raw) as LegacyDemoSwap;
    const swap: ActiveSwap = {
      role: "sandbox",
      orderId: null,
      direction: old.direction,
      fromAmount: old.fromAmount,
      toAmount: old.toAmount,
      makerEthAccount: old.ethAccount,
      makerQrlAccount: old.qrlAccount,
      takerEthAccount: old.ethAccount,
      takerQrlAccount: old.qrlAccount,
      preimage: old.preimage,
      hashlock: old.hashlock,
      initiatorTimeout: old.initiatorTimeout,
      responderTimeout: old.responderTimeout,
      createdAt: old.createdAt,
    };
    localStorage.removeItem(LEGACY_KEY);
    saveActiveSwap(swap);
    return swap;
  } catch {
    return null;
  }
}

export function loadActiveSwap(): ActiveSwap | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as ActiveSwap;
    return migrateLegacy();
  } catch {
    return null;
  }
}

export function saveActiveSwap(swap: ActiveSwap): void {
  localStorage.setItem(KEY, JSON.stringify(swap));
}

export function clearActiveSwap(): void {
  localStorage.removeItem(KEY);
}

/** The maker's open-order handle; the token authorizes cancel + hashlock. */
export interface MyOrderRef {
  id: string;
  token: string;
}

const ORDER_KEY = "quantaswap.myorder.v1";

export function loadMyOrder(): MyOrderRef | null {
  try {
    const raw = localStorage.getItem(ORDER_KEY);
    return raw ? (JSON.parse(raw) as MyOrderRef) : null;
  } catch {
    return null;
  }
}

export function saveMyOrder(ref: MyOrderRef): void {
  localStorage.setItem(ORDER_KEY, JSON.stringify(ref));
}

export function clearMyOrder(): void {
  localStorage.removeItem(ORDER_KEY);
}
