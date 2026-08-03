// Advisory pre-take verification of a pre-funded order's escrow claim.
// The book cannot prove funding (it has no RPC on purpose), so
// `prelocked: true` is only the maker's word until the escrow is read
// on-chain. This check runs at the head before a taker reserves the
// order; the HARD safety gate stays the swap machine's at-depth
// verification after accept, exactly as for classic locks.

import { formatUnits } from "ethers";
import { ETH_ASSETS, MIN_TAKEABLE_RUNWAY_S, type EthAssetSymbol } from "../config";
import { NATIVE_TOKEN, SwapStatus, getLegState } from "./htlc";
import { initiatorLeg } from "./activeSwap";
import { sameAddr } from "./swapMachine";
import type { OrderView } from "./orderbook";

const ZERO_ADDR = `0x${"0".repeat(40)}`;

/** Returns a human-readable problem with the escrow, or null when it
 *  checks out. Throws only on RPC failure (callers show "unverified"). */
export async function prelockEscrowIssue(
  order: OrderView,
  assetSymbol: EthAssetSymbol,
): Promise<string | null> {
  if (order.hashlock === null || order.initiatorTimeout === null) {
    return "the order carries no escrow anchors";
  }
  const leg = initiatorLeg(order.direction);
  const asset = ETH_ASSETS[assetSymbol];
  const expectedToken = leg === "eth" ? (asset.address ?? NATIVE_TOKEN) : NATIVE_TOKEN;
  const state = await getLegState(leg, order.hashlock);
  if (state.status !== SwapStatus.Open) {
    return "no open escrow exists under this order's hashlock";
  }
  if (!sameAddr(state.token, expectedToken)) {
    return "the escrow holds a different asset than the order sells";
  }
  if (state.amount !== BigInt(order.fromAmount)) {
    const decimals = leg === "eth" ? asset.decimals : 18;
    return `the escrow holds ${formatUnits(state.amount, decimals)}, not the listed amount`;
  }
  if (!sameAddr(state.recipient, ZERO_ADDR)) {
    return "the escrow is already assigned to another taker";
  }
  if (state.timeout - Math.floor(Date.now() / 1000) < MIN_TAKEABLE_RUNWAY_S) {
    return "too little time remains on the escrow to swap safely";
  }
  return null;
}
