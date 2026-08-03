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
  /** Share token of a private order: both participants keep it so they
   *  can go on reading the listing (hashlock announce, status polls),
   *  which 404s without it. Absent/null for public orders. */
  shareToken?: string | null;
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
  /** The initiator leg was pre-funded with an open-recipient lock at post
   *  time: the maker's match step is assign() instead of a lock, and the
   *  escrow is releasable on demand until then. Absent means classic. */
  prelocked?: boolean;
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

/** A pre-funded order's escrow anchors, persisted BEFORE the lock
 *  transaction is broadcast: losing the preimage after funds are on-chain
 *  would strand them until T1's permissionless refund. */
export interface PrelockRef {
  hashlock: string;
  preimage: string;
  /** The open lock's fixed on-chain T1 (unix seconds). */
  initiatorTimeout: number;
  /** The leg the escrow sits on (the order's initiator leg). */
  leg: LegKey;
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
  /** Share token when the order is private (null for public orders):
   *  builds the /o/<id> link and authorizes the maker's own reads. */
  shareToken: string | null;
  /** Pre-funded escrow anchors; null for classic (unfunded) listings. At
   *  match the stored secret and T1 are reused verbatim, never
   *  regenerated (the on-chain lock is immutable). */
  prelock: PrelockRef | null;
}

const ORDER_KEY = "quantaswap.myorder.v1";

export function loadMyOrder(): MyOrderRef | null {
  try {
    const raw = localStorage.getItem(ORDER_KEY);
    if (!raw) return null;
    const ref = JSON.parse(raw) as MyOrderRef;
    // Handles stored before the ETH-leg asset existed mean native ETH.
    ref.asset = ethAssetSymbolOrNull(ref.asset) ?? "ETH";
    // Handles stored before amount anchoring / private orders existed.
    ref.fromAmount ??= null;
    ref.toAmount ??= null;
    ref.shareToken ??= null;
    // Handles stored before pre-funded orders existed.
    ref.prelock ??= null;
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

/** Staging record for an in-flight pre-funded post: written before the
 *  escrow transaction, deleted only once the order exists and the handle
 *  above holds the anchors. A crash in between leaves this record + an
 *  on-chain open lock and no order id; the reconcile UI offers finishing
 *  the post or releasing the escrow. Carries the full order terms so a
 *  resumed post is byte-identical to the interrupted one. */
export interface PrelockStage extends PrelockRef {
  direction: Direction;
  asset: EthAssetSymbol;
  fromAmount: string;
  toAmount: string;
  visibility: "public" | "private";
  allowedTakerEth: string | null;
  allowedTakerQrl: string | null;
  createdAt: number;
}

const STAGE_KEY = "quantaswap.prelockstage.v1";

export function loadPrelockStage(): PrelockStage | null {
  try {
    const raw = localStorage.getItem(STAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as PrelockStage;
  } catch {
    return null;
  }
}

export function savePrelockStage(stage: PrelockStage): void {
  localStorage.setItem(STAGE_KEY, JSON.stringify(stage));
}

export function clearPrelockStage(): void {
  localStorage.removeItem(STAGE_KEY);
}
