// Ethereum-leg asset registry for order validation. Hand-copied from
// config/tokens.json (chain 11155111): it must stay in sync by hand
// because prod deploys tar only server/* (docs/DEPLOYMENTS.md), so the
// server cannot read the repo-root config at runtime.
//
// The book never carries token addresses. Orders carry the asset SYMBOL
// only; every client resolves symbol -> token address from its own
// compiled-in registry and verifies escrow token addresses on-chain, so
// a corrupted book cannot point anyone at a hostile token.
//
// Bounds are mirrored client-side; keep in sync with
// frontend/src/config.ts.

import { ApiError } from "./errors.js";

/** Ethereum-leg asset symbols on the wire. An absent field means ETH
 *  (pre-asset clients and rows persisted before the stablecoin rollout). */
export type AssetSymbol = "ETH" | "USDC" | "tUSDT";

/** Amount bounds in base units for one side of an order. */
export interface AmountBounds {
  readonly minBaseUnits: bigint;
  readonly maxBaseUnits: bigint;
  /** Human-readable dust floor for error strings ("0.001", "1 USDC"). */
  readonly minLabel: string;
}

export interface Asset extends AmountBounds {
  readonly symbol: AssetSymbol;
  readonly decimals: number;
}

/** The QRL leg is always native QRL: 18 decimals, ETH-like bounds. */
export const QRL_BOUNDS: AmountBounds = {
  minBaseUnits: 10n ** 15n, // 0.001 QRL, dust/spam guard
  maxBaseUnits: 10n ** 24n,
  minLabel: "0.001",
};

const ETH: Asset = {
  symbol: "ETH",
  decimals: 18,
  minBaseUnits: 10n ** 15n, // 0.001 ETH, dust/spam guard
  maxBaseUnits: 10n ** 24n,
  minLabel: "0.001",
};

const USDC: Asset = {
  symbol: "USDC",
  decimals: 6,
  minBaseUnits: 10n ** 6n, // 1 USDC
  maxBaseUnits: 10n ** 13n,
  minLabel: "1 USDC",
};

const TUSDT: Asset = {
  symbol: "tUSDT",
  decimals: 6,
  minBaseUnits: 10n ** 6n, // 1 tUSDT
  maxBaseUnits: 10n ** 13n,
  minLabel: "1 tUSDT",
};

const BY_SYMBOL: ReadonlyMap<string, Asset> = new Map(
  [ETH, USDC, TUSDT].map((a) => [a.symbol, a]),
);

/** Validates a wire-level asset field. Absent means ETH so pre-asset
 *  clients keep working; anything else must name a known symbol
 *  exactly (case-sensitive). */
export function requireAsset(raw: unknown): Asset {
  if (raw === undefined) return ETH;
  if (typeof raw === "string") {
    const asset = BY_SYMBOL.get(raw);
    if (asset !== undefined) return asset;
  }
  throw new ApiError(400, "asset must be one of ETH, USDC, tUSDT");
}
