// Local persistence for the in-flight swap. The preimage is safety-critical
// state: losing it after the counterparty locked means waiting out the
// refund path, so it stays in localStorage until the swap reaches a
// terminal state on both legs. The taker never holds the preimage.

import type { LegKey } from "../config";
import { ethAssetSymbolOrNull, type EthAssetSymbol } from "./assetRegistry";

export type Direction = "eth->qrl" | "qrl->eth";
export type SwapRole = "maker" | "taker" | "sandbox";

export interface ActiveSwap {
  role: SwapRole;
  /** Order book id; null in the sandbox. */
  orderId: string | null;
  /** Authorizes the taker's release (walk-away) on the order book; null
   *  for maker/sandbox roles and for swaps stored before it existed. */
  takerToken: string | null;
  /** Maker's perspective: the maker escrows `fromAmount` on the from-chain. */
  direction: Direction;
  /** The asset escrowed on the Ethereum leg. Agreed at take time and
   *  persisted here; counterparty locks are verified against THIS value's
   *  registry address, never against anything book-provided. Swaps stored
   *  before it existed hydrate to "ETH". */
  ethAsset: EthAssetSymbol;
  /** Base units of the initiator (maker) leg's asset, decimal string
   *  (QRL wei for the qrl leg; the ETH-leg asset's base units otherwise). */
  fromAmount: string;
  /** Base units of the responder (taker) leg's asset, decimal string. */
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
      takerToken: null,
      direction: old.direction,
      // The demo predates ERC-20 legs: always native ETH.
      ethAsset: "ETH",
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
    if (raw) {
      const swap = JSON.parse(raw) as ActiveSwap;
      // Swaps stored before the taker token existed.
      swap.takerToken ??= null;
      // Swaps stored before the ETH-leg asset existed mean native ETH;
      // anything the registry does not know also normalizes to ETH, which
      // fails closed downstream (token verification rejects the mismatch).
      swap.ethAsset = ethAssetSymbolOrNull(swap.ethAsset) ?? "ETH";
      return swap;
    }
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

/** The maker's open-order handle; the token authorizes cancel + hashlock.
 *  The asset AND both amounts are anchored locally at post time (like the
 *  maker's payout addresses) so a hostile book cannot re-label or resize
 *  the maker's own order at match time. */
export interface MyOrderRef {
  id: string;
  token: string;
  asset: EthAssetSymbol;
  /** Base units the maker escrows, decimal string; null on handles stored
   *  before amount anchoring existed (those fall back to the book copy). */
  fromAmount: string | null;
  /** Base units the maker expects, decimal string; null pre-anchoring. */
  toAmount: string | null;
}

const ORDER_KEY = "quantaswap.myorder.v1";

export function loadMyOrder(): MyOrderRef | null {
  try {
    const raw = localStorage.getItem(ORDER_KEY);
    if (!raw) return null;
    const ref = JSON.parse(raw) as MyOrderRef;
    // Handles stored before the ETH-leg asset existed mean native ETH.
    ref.asset = ethAssetSymbolOrNull(ref.asset) ?? "ETH";
    // Handles stored before amount anchoring existed.
    ref.fromAmount ??= null;
    ref.toAmount ??= null;
    return ref;
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
