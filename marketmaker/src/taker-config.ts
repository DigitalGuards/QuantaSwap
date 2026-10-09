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
  /** Margin the maker escrow's timeout must leave beyond our own deadline
   *  before we fund. Defaults to the browser taker's 30 minutes. */
  claimSafetyS: number;
  /** Refuse to fund this close to our own responder deadline. */
  lockRunwayS: number;
  /** Runway an order proof must still carry before we propose against it.
   *  A maker answers a proposal with a FillV2 whose response window is at
   *  least 60 seconds and must sit inside the order's own validity, so a
   *  proposal against a proof with less than that left can never be filled.
   *  The default adds a maker tick on top of that 60 second floor. Live
   *  quotes are short: the first-party staging maker signs 300 second
   *  proofs, so a larger floor refuses the whole book. */
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
    claimSafetyS: envInt("TAKER_CLAIM_SAFETY_S", 1_800),
    lockRunwayS: envInt("TAKER_LOCK_RUNWAY_S", 900),
    minOrderRunwayS: envInt("TAKER_MIN_ORDER_RUNWAY_S", 90),
    ethGasReserveWei: envWei("TAKER_ETH_GAS_RESERVE_WEI", 2n * 10n ** 15n),
    qrlGasReserveWei: envWei("TAKER_QRL_GAS_RESERVE_WEI", 10n ** 18n),
    stateFile: env(
      "TAKER_STATE_FILE",
      new URL("../data/taker-state.json", import.meta.url).pathname,
    ),
  };
}

/** Margin below an escrow's own deadline where a claim can no longer be
 *  expected to mine, so submitting one only burns the retry slot. */
export function claimSubmitMarginS(cfg: { txTimeoutMs: number }): number {
  return Math.ceil(cfg.txTimeoutMs / 1000) + 60;
}

/**
 * The claim margin the taker demands from a maker escrow has to exceed the
 * margin where its own claim stops being submittable, or the claim window
 * is empty by construction and the swap can only settle unevenly. Refuse
 * to start on that configuration, so it surfaces before a swap does.
 */
export function assertClaimWindowIsUsable(cfg: TakerReadConfig): void {
  const submitMargin = claimSubmitMarginS(cfg);
  if (cfg.claimSafetyS <= submitMargin) {
    throw new Error(
      `TAKER_CLAIM_SAFETY_S (${cfg.claimSafetyS}s) must exceed the transaction submission margin of ${submitMargin}s ` +
        `(TAKER_TX_TIMEOUT_MS / 1000 plus 60), or a verified escrow leaves no window this client could claim in. ` +
        `Raise TAKER_CLAIM_SAFETY_S or lower TAKER_TX_TIMEOUT_MS`,
    );
  }
}

export function loadTakerConfig(): TakerConfig {
  const cfg = {
    ...loadTakerReadConfig(),
    ethPrivateKey: readRequiredSecret("TAKER_ETH_PRIVATE_KEY"),
    qrlHexseed: readRequiredSecret("TAKER_QRL_HEXSEED"),
  };
  assertClaimWindowIsUsable(cfg);
  return cfg;
}
