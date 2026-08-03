// Env-driven configuration. The two signing secrets are required; every
// knob has a testnet-sized default. Amounts are base-unit bigints (wei
// for the native coins, token units for ERC-20 assets).

import { assetInfo, isAssetSymbol, ASSET_SYMBOLS, type AssetSymbol } from "./assets.js";

/** Ladder policy for one ETH-leg asset. */
export interface AssetPolicy {
  /** Rung-0 listing size in the asset's base units. */
  baseUnits: bigint;
  /** Inventory floor kept unlisted, in the asset's base units. */
  reserveUnits: bigint;
  /** Price-ladder rungs per direction for this asset's pair. */
  ordersPerDirection: number;
}

export interface Config {
  /** ETH-leg assets to stock, from MM_ASSETS (default native ETH only).
   *  Every entry must have a price feed; tUSDT (no feed) is rejected. */
  assets: AssetSymbol[];
  /** Per-asset ladder policy, one entry per configured asset. ETH reuses
   *  the wei knobs below; token assets read MM_<ASSET>_BASE,
   *  MM_<ASSET>_RESERVE (human units), MM_<ASSET>_ORDERS_PER_DIRECTION. */
  assetPolicies: Map<AssetSymbol, AssetPolicy>;
  orderbookUrl: string;
  ethRpcUrl: string;
  qrlRpcUrl: string;
  /** Expected deployment chain IDs, persisted with every managed order. */
  ethChainId: string;
  qrlChainId: string;
  ethHtlc: string;
  qrlHtlc: string;
  ethPrivateKey: string;
  qrlHexseed: string;
  /** Open orders to keep listed per direction. */
  ordersPerDirection: number;
  /** Concurrent listings per price rung. 2 lets a second taker start the
   *  same trade while the first swap is still settling. */
  ordersPerLevel: number;
  /** Max orders simultaneously past `open` (accepted/locking). Caps how
   *  much inventory a griefer can tie up in half-open swaps at once. */
  maxInflight: number;
  ethOrderWei: bigint;
  /** Static mid (QRL/ETH integer milli); only used when the feed is off,
   *  and only for the ETH pair (token pairs never quote without a feed). */
  midPriceMilli: bigint;
  /** "coingecko" tracks the live cross rate; "off" pins midPriceMilli. */
  priceFeed: "coingecko" | "off";
  priceRefreshS: number;
  /** Stop posting when the cached price is older than this. */
  priceMaxAgeS: number;
  /** Cancel-and-repost open listings when the mid drifts beyond this. */
  repriceThresholdBps: bigint;
  /** Ladder step in basis points per level (asks above, bids below mid). */
  levelStepBps: bigint;
  /** Never let a chain balance fall below this (gas + griefing headroom). */
  ethReserveWei: bigint;
  qrlReserveWei: bigint;
  /** Blocks behind the head a counterparty lock must be visible at. */
  confirmations: number;
  tickMs: number;
  /** Hard deadline on any single network request (RPC call, book call,
   *  price fetch). Bounds a stalling or hostile endpoint so it can never
   *  wedge the single-threaded tick. */
  netTimeoutMs: number;
  /** Deadline on waiting for one of our own transactions to confirm.
   *  Larger than netTimeoutMs since mining legitimately takes blocks; a
   *  genuinely stuck tx throws and is reconciled from chain state next tick. */
  txTimeoutMs: number;
  /** Re-send a transaction if its effect is not on-chain after this long. */
  resendAfterS: number;
  /** Do not claim (or lock) within this margin of the responder timeout. */
  claimSafetyS: number;
  /** Wait this long after announcing before locking, so an instant taker
   *  walk-away releases before our funds move. */
  lockGraceS: number;
  initiatorWindowS: number;
  responderWindowS: number;
  stateFile: string;
}

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

function envInt(name: string, fallback: number): number {
  const v = Number(env(name, String(fallback)));
  if (!Number.isFinite(v) || v <= 0) throw new Error(`${name} must be a positive number`);
  return Math.floor(v);
}

function envWei(name: string, fallback: bigint): bigint {
  const raw = env(name, fallback.toString());
  if (!/^[0-9]{1,30}$/.test(raw)) throw new Error(`${name} must be a decimal wei string`);
  return BigInt(raw);
}

function envChainId(name: string, fallback: string): string {
  const raw = env(name, fallback);
  if (!/^[0-9]+$/.test(raw) || BigInt(raw) <= 0n) {
    throw new Error(`${name} must be a positive decimal chain ID`);
  }
  return BigInt(raw).toString(10);
}

function required(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") throw new Error(`${name} is required`);
  return v;
}

/** Human-unit decimal amount (e.g. "5" or "2.5" USDC) to base units. */
function envUnits(name: string, fallback: string, decimals: number): bigint {
  const raw = env(name, fallback);
  const m = /^([0-9]{1,15})(?:\.([0-9]+))?$/.exec(raw);
  if (m === null || (m[2] !== undefined && m[2].length > decimals)) {
    throw new Error(`${name} must be a decimal amount with at most ${decimals} fractional digits`);
  }
  return BigInt((m[1] ?? "0") + (m[2] ?? "").padEnd(decimals, "0"));
}

function parseAssets(raw: string): AssetSymbol[] {
  const out: AssetSymbol[] = [];
  for (const part of raw.split(",")) {
    const sym = part.trim();
    if (sym === "") continue;
    if (!isAssetSymbol(sym)) {
      throw new Error(`MM_ASSETS: unknown asset "${sym}" (valid: ${ASSET_SYMBOLS.join(", ")})`);
    }
    if (assetInfo(sym).coingeckoId === null) {
      throw new Error(`MM_ASSETS: ${sym} has no price feed and cannot be stocked`);
    }
    if (out.includes(sym)) throw new Error(`MM_ASSETS: duplicate asset "${sym}"`);
    out.push(sym);
  }
  if (out.length === 0) throw new Error("MM_ASSETS must list at least one asset");
  return out;
}

/** Per-asset ladder knobs. ETH keeps its original env surface; token
 *  assets read MM_<ASSET>_* in human units (defaults sized for USDC). */
function loadAssetPolicies(
  assets: AssetSymbol[],
  eth: AssetPolicy,
): Map<AssetSymbol, AssetPolicy> {
  const policies = new Map<AssetSymbol, AssetPolicy>();
  for (const symbol of assets) {
    if (symbol === "ETH") {
      policies.set(symbol, eth);
      continue;
    }
    const info = assetInfo(symbol);
    const prefix = `MM_${symbol.toUpperCase()}`;
    const policy: AssetPolicy = {
      baseUnits: envUnits(`${prefix}_BASE`, "5", info.decimals),
      reserveUnits: envUnits(`${prefix}_RESERVE`, "6", info.decimals),
      ordersPerDirection: envInt(`${prefix}_ORDERS_PER_DIRECTION`, 2),
    };
    if (policy.baseUnits < info.minBaseUnits) {
      throw new Error(`${prefix}_BASE is below the ${symbol} minimum lock amount`);
    }
    policies.set(symbol, policy);
  }
  return policies;
}

export function loadConfig(): Config {
  const assets = parseAssets(env("MM_ASSETS", "ETH"));
  const ordersPerDirection = envInt("MM_ORDERS_PER_DIRECTION", 2);
  const ethOrderWei = envWei("MM_ETH_ORDER_WEI", 2n * 10n ** 16n); // 0.02 ETH base size
  const ethReserveWei = envWei("MM_ETH_RESERVE_WEI", 5n * 10n ** 16n);
  return {
    assets,
    assetPolicies: loadAssetPolicies(assets, {
      baseUnits: ethOrderWei,
      reserveUnits: ethReserveWei,
      ordersPerDirection,
    }),
    orderbookUrl: env("MM_ORDERBOOK_URL", "http://127.0.0.1:8091/api"),
    ethRpcUrl: env("MM_ETH_RPC_URL", "https://ethereum-sepolia-rpc.publicnode.com"),
    qrlRpcUrl: env("MM_QRL_RPC_URL", "http://127.0.0.1:8545"),
    ethChainId: envChainId("MM_ETH_CHAIN_ID", "11155111"),
    qrlChainId: envChainId("MM_QRL_CHAIN_ID", "1337"),
    // 2026-07-13 redeploy: HTLCv2 open-recipient locks (assign + release) on
    // both legs (docs/DEPLOYMENTS.md). The MM does not prelock, so its own
    // flow is unchanged; it just points at the new addresses.
    ethHtlc: env("MM_ETH_HTLC", "0x910D5d4a7f2037c01F3B4C835167357e89909281"),
    qrlHtlc: env("MM_QRL_HTLC", "Q238322ad2e8f935b4481fcc379779c31b84decb0"),
    ethPrivateKey: required("MM_ETH_PRIVATE_KEY"),
    qrlHexseed: required("MM_QRL_HEXSEED"),
    ordersPerDirection,
    ordersPerLevel: envInt("MM_ORDERS_PER_LEVEL", 1),
    maxInflight: envInt("MM_MAX_INFLIGHT", 2),
    ethOrderWei,
    // Fallback for MM_PRICE_FEED=off (roughly the mid-2026 cross rate).
    midPriceMilli: envWei("MM_MID_PRICE_MILLI", 1_700_000n), // 1700 QRL/ETH
    priceFeed: env("MM_PRICE_FEED", "coingecko") === "off" ? "off" : "coingecko",
    priceRefreshS: envInt("MM_PRICE_REFRESH_S", 300),
    priceMaxAgeS: envInt("MM_PRICE_MAX_AGE_S", 1800),
    repriceThresholdBps: envWei("MM_REPRICE_THRESHOLD_BPS", 100n), // 1%
    levelStepBps: envWei("MM_LEVEL_STEP_BPS", 50n), // 0.5% per rung
    ethReserveWei,
    qrlReserveWei: envWei("MM_QRL_RESERVE_WEI", 5n * 10n ** 18n),
    confirmations: envInt("MM_CONFIRMATIONS", 3),
    tickMs: envInt("MM_TICK_MS", 15_000),
    netTimeoutMs: envInt("MM_NET_TIMEOUT_MS", 20_000),
    txTimeoutMs: envInt("MM_TX_TIMEOUT_MS", 180_000),
    resendAfterS: envInt("MM_RESEND_AFTER_S", 240),
    claimSafetyS: envInt("MM_CLAIM_SAFETY_S", 600),
    lockGraceS: envInt("MM_LOCK_GRACE_S", 30),
    initiatorWindowS: envInt("MM_INITIATOR_WINDOW_S", 7200),
    responderWindowS: envInt("MM_RESPONDER_WINDOW_S", 3600),
    stateFile: env("MM_STATE_FILE", new URL("../data/state.json", import.meta.url).pathname),
  };
}
