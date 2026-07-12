// Ethereum-leg asset registry for the Sepolia leg (chain 11155111).
//
// SYNC NOTE: hand-mirrored from ../../config/tokens.json (the repo-level
// registry). Vite's dev server cannot import files outside the package
// root without widening server.fs.allow, so the three enabled assets are
// mirrored here as typed constants instead. Any change to addresses,
// decimals, minLockAmount or quirks in config/tokens.json must be
// reflected here, and vice versa.
//
// Asset identity on the wire and in persistence is the SYMBOL string;
// an absent field (old clients, old persisted rows) means "ETH". The
// order book never carries token addresses: this compiled-in registry is
// the only source clients resolve a symbol against, and on-chain escrow
// token addresses are verified against it, never against anything
// book-provided.

export type EthAssetSymbol = "ETH" | "USDC" | "tUSDT";

export interface EthAssetQuirks {
  /** Changing a nonzero allowance to another nonzero value reverts
   *  (USDT-style); reset the allowance to 0 first. */
  readonly approvalRace: boolean;
  /** approve/transfer return no data (USDT-style); never decode their
   *  return values, judge success by the receipt status only. */
  readonly noReturnValue: boolean;
  /** The issuer can blocklist addresses, which can strand a leg. */
  readonly issuerBlocklist: boolean;
}

export interface EthAsset {
  readonly symbol: EthAssetSymbol;
  /** ERC-20 contract address on Sepolia, or null for the native coin. */
  readonly address: string | null;
  readonly decimals: number;
  /** Order-book dust floor in base units (tokens.json minLockAmount). */
  readonly minBaseUnits: bigint;
  readonly quirks: EthAssetQuirks;
}

const NO_QUIRKS: EthAssetQuirks = {
  approvalRace: false,
  noReturnValue: false,
  issuerBlocklist: false,
};

export const ETH_ASSETS: Record<EthAssetSymbol, EthAsset> = {
  ETH: {
    symbol: "ETH",
    address: null,
    decimals: 18,
    // 0.001 ETH
    minBaseUnits: 10n ** 15n,
    quirks: NO_QUIRKS,
  },
  USDC: {
    symbol: "USDC",
    // Circle Sepolia USDC (faucet.circle.com)
    address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    decimals: 6,
    // 1 USDC
    minBaseUnits: 10n ** 6n,
    quirks: { approvalRace: false, noReturnValue: false, issuerBlocklist: true },
  },
  tUSDT: {
    symbol: "tUSDT",
    // QuantaSwap Test USDT (TestStable.hyp faucet token, deployed 2026-07-12)
    address: "0x027847Dc41C7a3198a28B9c7B27B5a0BC5bD23A0",
    decimals: 6,
    // 1 tUSDT
    minBaseUnits: 10n ** 6n,
    quirks: { approvalRace: true, noReturnValue: true, issuerBlocklist: false },
  },
};

/** Stable UI/order iteration order for the pairs. */
export const ETH_ASSET_SYMBOLS: readonly EthAssetSymbol[] = ["ETH", "USDC", "tUSDT"];

/** Normalizes a wire/persisted asset field: absent means the legacy
 *  native pair ("ETH"); anything the registry does not know is null so
 *  callers fail closed instead of silently treating junk as ETH. */
export function ethAssetSymbolOrNull(raw: string | undefined): EthAssetSymbol | null {
  if (raw === undefined) return "ETH";
  return raw === "ETH" || raw === "USDC" || raw === "tUSDT" ? raw : null;
}

/** Resolves an on-chain ERC-20 address to a registry asset, or null for
 *  tokens this build does not know (callers must not render those as any
 *  known asset). */
export function ethAssetByAddress(address: string): EthAsset | null {
  const needle = address.toLowerCase();
  for (const symbol of ETH_ASSET_SYMBOLS) {
    const asset = ETH_ASSETS[symbol];
    if (asset.address !== null && asset.address.toLowerCase() === needle) return asset;
  }
  return null;
}
