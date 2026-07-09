// Env-driven configuration. The two signing secrets are required; every
// knob has a testnet-sized default. Amounts are wei bigints.

export interface Config {
  orderbookUrl: string;
  ethRpcUrl: string;
  qrlRpcUrl: string;
  ethHtlc: string;
  qrlHtlc: string;
  ethPrivateKey: string;
  qrlHexseed: string;
  /** Open orders to keep listed per direction. */
  ordersPerDirection: number;
  /** Max orders simultaneously past `open` (accepted/locking). Caps how
   *  much inventory a griefer can tie up in half-open swaps at once. */
  maxInflight: number;
  ethOrderWei: bigint;
  /** Ladder mid price, QRL per ETH in integer milli (100000 = 100.000). */
  midPriceMilli: bigint;
  /** Ladder step in basis points per level (asks above, bids below mid). */
  levelStepBps: bigint;
  /** Never let a chain balance fall below this (gas + griefing headroom). */
  ethReserveWei: bigint;
  qrlReserveWei: bigint;
  /** Blocks behind the head a counterparty lock must be visible at. */
  confirmations: number;
  tickMs: number;
  /** Re-send a transaction if its effect is not on-chain after this long. */
  resendAfterS: number;
  /** Do not claim (or lock) within this margin of the responder timeout. */
  claimSafetyS: number;
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

function required(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") throw new Error(`${name} is required`);
  return v;
}

export function loadConfig(): Config {
  return {
    orderbookUrl: env("MM_ORDERBOOK_URL", "http://127.0.0.1:8091/api"),
    ethRpcUrl: env("MM_ETH_RPC_URL", "https://ethereum-sepolia-rpc.publicnode.com"),
    qrlRpcUrl: env("MM_QRL_RPC_URL", "http://127.0.0.1:8545"),
    ethHtlc: env("MM_ETH_HTLC", "0x805100Fa4310B9c0dbb0754E14CbDe827E3b8a3c"),
    qrlHtlc: env("MM_QRL_HTLC", "Q94cd8e406d2bb4ea251dce3f0558941f2ac056ee"),
    ethPrivateKey: required("MM_ETH_PRIVATE_KEY"),
    qrlHexseed: required("MM_QRL_HEXSEED"),
    ordersPerDirection: envInt("MM_ORDERS_PER_DIRECTION", 2),
    maxInflight: envInt("MM_MAX_INFLIGHT", 2),
    ethOrderWei: envWei("MM_ETH_ORDER_WEI", 2n * 10n ** 16n), // 0.02 ETH base size
    // Roughly the real-world cross rate (ETH ~1700 USD, QRL ~1 USD).
    midPriceMilli: envWei("MM_MID_PRICE_MILLI", 1_700_000n), // 1700 QRL/ETH
    levelStepBps: envWei("MM_LEVEL_STEP_BPS", 50n), // 0.5% per rung
    ethReserveWei: envWei("MM_ETH_RESERVE_WEI", 5n * 10n ** 16n),
    qrlReserveWei: envWei("MM_QRL_RESERVE_WEI", 5n * 10n ** 18n),
    confirmations: envInt("MM_CONFIRMATIONS", 3),
    tickMs: envInt("MM_TICK_MS", 15_000),
    resendAfterS: envInt("MM_RESEND_AFTER_S", 240),
    claimSafetyS: envInt("MM_CLAIM_SAFETY_S", 600),
    initiatorWindowS: envInt("MM_INITIATOR_WINDOW_S", 7200),
    responderWindowS: envInt("MM_RESPONDER_WINDOW_S", 3600),
    stateFile: env("MM_STATE_FILE", new URL("../data/state.json", import.meta.url).pathname),
  };
}
