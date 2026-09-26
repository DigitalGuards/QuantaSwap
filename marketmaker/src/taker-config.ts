// Env-driven configuration for the scripted taker. It mirrors the maker's
// surface (src/config.ts) with a TAKER_ prefix and the same secret
// handling: the two signing keys are required, direct or through a
// NAME_FILE indirection, and every other knob has a testnet default.

import {
  env,
  envChainId,
  envInt,
  envWei,
  readRequiredSecret,
} from "./config.js";
import { protocolV2Config } from "./protocol-v2-config.js";

/** Everything the read-only commands need. `list` and `quote` run on this
 *  alone, so they never touch key material. */
export interface TakerReadConfig {
  orderbookUrl: string;
  ethRpcUrl: string;
  qrlRpcUrl: string;
  ethChainId: string;
  qrlChainId: string;
  ethHtlc: string;
  qrlHtlc: string;
  /** Blocks behind the head the maker escrow must be visible at. */
  confirmations: number;
  /** Deadline on any single network request (RPC, book). */
  netTimeoutMs: number;
  /** Deadline on waiting for one of our own transactions to confirm. */
  txTimeoutMs: number;
  /** Poll period while a take is in flight. */
  pollMs: number;
  /** Re-send a transaction if its effect is not on chain after this long. */
  resendAfterS: number;
  /** Margin a counterparty timeout must leave before we act on it. */
  claimSafetyS: number;
  /** Refuse to fund this close to our own responder deadline. */
  lockRunwayS: number;
  /** Runway an order proof must still have before we propose against it. */
  minOrderRunwayS: number;
  /** Native balance kept free for gas on the Ethereum leg. */
  ethGasReserveWei: bigint;
  /** Native balance kept free for gas on the QRL leg. */
  qrlGasReserveWei: bigint;
  stateFile: string;
}

export interface TakerConfig extends TakerReadConfig {
  ethPrivateKey: string;
  qrlHexseed: string;
}

export function loadTakerReadConfig(): TakerReadConfig {
  return {
    orderbookUrl: env("TAKER_ORDERBOOK_URL", "https://quantaswap.io/api"),
    ethRpcUrl: env(
      "TAKER_ETH_RPC_URL",
      "https://ethereum-sepolia-rpc.publicnode.com",
    ),
    qrlRpcUrl: env(
      "TAKER_QRL_RPC_URL",
      "https://qrlwallet.com/api/qrl-rpc/testnet",
    ),
    ethChainId: envChainId("TAKER_ETH_CHAIN_ID", protocolV2Config.ethChainId),
    qrlChainId: envChainId("TAKER_QRL_CHAIN_ID", protocolV2Config.qrlChainId),
    ethHtlc: env("TAKER_ETH_HTLC", protocolV2Config.ethHtlc),
    qrlHtlc: env("TAKER_QRL_HTLC", protocolV2Config.qrlHtlc),
    confirmations: envInt("TAKER_CONFIRMATIONS", 3),
    netTimeoutMs: envInt("TAKER_NET_TIMEOUT_MS", 20_000),
    txTimeoutMs: envInt("TAKER_TX_TIMEOUT_MS", 180_000),
    pollMs: envInt("TAKER_POLL_MS", 5_000),
    resendAfterS: envInt("TAKER_RESEND_AFTER_S", 240),
    claimSafetyS: envInt("TAKER_CLAIM_SAFETY_S", 600),
    lockRunwayS: envInt("TAKER_LOCK_RUNWAY_S", 900),
    minOrderRunwayS: envInt("TAKER_MIN_ORDER_RUNWAY_S", 900),
    ethGasReserveWei: envWei("TAKER_ETH_GAS_RESERVE_WEI", 2n * 10n ** 15n),
    qrlGasReserveWei: envWei("TAKER_QRL_GAS_RESERVE_WEI", 10n ** 18n),
    stateFile: env(
      "TAKER_STATE_FILE",
      new URL("../data/taker-state.json", import.meta.url).pathname,
    ),
  };
}

export function loadTakerConfig(): TakerConfig {
  return {
    ...loadTakerReadConfig(),
    ethPrivateKey: readRequiredSecret("TAKER_ETH_PRIVATE_KEY"),
    qrlHexseed: readRequiredSecret("TAKER_QRL_HEXSEED"),
  };
}
