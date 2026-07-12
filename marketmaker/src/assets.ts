// Ethereum-leg asset registry, an embedded mirror of config/tokens.json
// (Sepolia, chain 11155111). The prod deploy tars only marketmaker/*, so
// this package can never read the repo-level registry at runtime: keep
// the two in sync by hand, registry file first. The order book never
// carries token addresses; the maker resolves symbol -> address here and
// verifies on-chain escrow token addresses against it, never against
// anything book-provided.

export const ASSET_SYMBOLS = ["ETH", "USDC", "tUSDT"] as const;
export type AssetSymbol = (typeof ASSET_SYMBOLS)[number];

export interface AssetQuirks {
  /** Nonzero -> nonzero approve reverts; reset the allowance to 0 first. */
  approvalRace: boolean;
  /** approve/transfer return no data; check receipt status, never decode
   *  return data. */
  noReturnValue: boolean;
  /** The issuer can freeze addresses, which can strand a leg mid-swap. */
  issuerBlocklist: boolean;
}

export interface AssetInfo {
  symbol: AssetSymbol;
  /** ERC-20 contract address on Sepolia, or null for the native coin. */
  tokenAddress: string | null;
  decimals: number;
  /** Dust floor for a lock, in the asset's base units. */
  minBaseUnits: bigint;
  quirks: AssetQuirks;
  /** CoinGecko id for the USD price feed; null means no feed exists and
   *  the asset cannot be stocked (enforced at config load). */
  coingeckoId: string | null;
}

const NO_QUIRKS: AssetQuirks = {
  approvalRace: false,
  noReturnValue: false,
  issuerBlocklist: false,
};

export const ASSETS: Record<AssetSymbol, AssetInfo> = {
  ETH: {
    symbol: "ETH",
    tokenAddress: null,
    decimals: 18,
    minBaseUnits: 10n ** 15n, // 0.001 ETH
    quirks: NO_QUIRKS,
    coingeckoId: "ethereum",
  },
  USDC: {
    symbol: "USDC",
    tokenAddress: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    decimals: 6,
    minBaseUnits: 10n ** 6n, // 1 USDC
    quirks: { ...NO_QUIRKS, issuerBlocklist: true },
    coingeckoId: "usd-coin",
  },
  tUSDT: {
    symbol: "tUSDT",
    tokenAddress: "0x027847Dc41C7a3198a28B9c7B27B5a0BC5bD23A0",
    decimals: 6,
    minBaseUnits: 10n ** 6n, // 1 tUSDT
    quirks: { ...NO_QUIRKS, approvalRace: true, noReturnValue: true },
    coingeckoId: null, // test-only faucet token; no feed, not stockable
  },
};

export function isAssetSymbol(value: string): value is AssetSymbol {
  return ASSET_SYMBOLS.some((s) => s === value);
}

export function assetInfo(symbol: AssetSymbol): AssetInfo {
  return ASSETS[symbol];
}
