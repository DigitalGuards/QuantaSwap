// `confirmations`: extra block depth a counterparty lock must reach
// before this client acts on it irreversibly (taker locking, maker
// revealing the secret). 0 acts as soon as the lock is included at the
// head block: a deliberate testnet-speed choice that accepts depth-1
// reorg risk (worst case, the maker's claim broadcast publishes the
// preimage while the taker's lock reorgs away; see lib/htlc.ts).
// Production MUST gate on the `finalized` tag instead (ARCHITECTURE
// section 2 sizes the timelock margins for full ~13 min finality).
export const QRL_LEG = {
  key: "qrl" as const,
  name: "QRL v2 testnet",
  asset: "QRL",
  chainIdHex: "0x539",
  // 2026-07-12 redeploy (lockToken enforces received == amount).
  htlc: "Qde1f2a65b0889bcb3f2ce271e8c6d1711425cf13",
  rpc: "/rpc/qrl",
  confirmations: 0,
  explorerTx: "https://zondscan.com/tx/",
  explorerAddress: "https://zondscan.com/address/",
};

export const ETH_LEG = {
  key: "eth" as const,
  name: "Sepolia",
  // The chain's native coin; ERC-20 legs carry their asset on the order
  // and the persisted swap (see lib/assetRegistry.ts).
  asset: "ETH",
  chainIdHex: "0xaa36a7",
  // 2026-07-12 redeploy (lockToken enforces received == amount).
  htlc: "0x31993bB91ECeD6141a1667c072f214C8DF20f7DB",
  rpc: "/rpc/sepolia",
  confirmations: 0,
  explorerTx: "https://sepolia.etherscan.io/tx/",
  explorerAddress: "https://sepolia.etherscan.io/address/",
};

// The ETH-leg asset model: the Sepolia leg can escrow native ETH or a
// registry ERC-20 (USDC, tUSDT); the QRL leg is always native QRL.
export {
  ETH_ASSETS,
  ETH_ASSET_SYMBOLS,
  ethAssetByAddress,
  ethAssetSymbolOrNull,
  type EthAsset,
  type EthAssetQuirks,
  type EthAssetSymbol,
} from "./lib/assetRegistry";

// Separate proxy for eth_getLogs only: publicnode's free tier refuses log
// scans ("archive request"), so event lookups go to the EF's ethpandaops
// endpoint, which serves them from genesis. Everything else stays on the
// main Sepolia RPC.
export const ETH_LOGS_RPC = "/rpc/sepolia-logs";

export type LegKey = "qrl" | "eth";

export const legByKey = (key: LegKey) => (key === "qrl" ? QRL_LEG : ETH_LEG);

// Demo timelocks. Real protocol-mode matching will size these per pair;
// the invariant is initiator >= 2x responder.
export const INITIATOR_TIMEOUT_S = 2 * 3600;
export const RESPONDER_TIMEOUT_S = 1 * 3600;

// Order book service, same-origin (nginx in prod, Vite proxy in dev).
export const ORDERBOOK_API = "/api";

// Dust guard for the QRL side of orders (0.001 QRL); mirrored server-side
// in server/src/store.ts. The ETH-leg floor is per asset: see
// EthAsset.minBaseUnits in lib/assetRegistry.ts.
export const MIN_QRL_AMOUNT_WEI = 10n ** 15n;

// A taker only locks if the maker's timeout leaves at least this much
// claim window beyond the responder timeout.
export const CLAIM_MARGIN_S = 30 * 60;

// Pre-funded (prelocked) listings: the open-recipient lock's T1 window,
// sized to the book's 48h listing TTL so the listing's expiry and the
// escrow's refund opening coincide.
export const PRELOCK_INITIATOR_TIMEOUT_S = 48 * 3600;

// A prelocked order is takeable only while this much of its fixed T1
// remains: the announce-time 2x invariant for a fresh responder window,
// plus the claim margin for accept->announce->assign latency. Mirrored
// server-side in server/src/store.ts (MIN_TAKEABLE_RUNWAY_S).
export const MIN_TAKEABLE_RUNWAY_S = 2 * RESPONDER_TIMEOUT_S + CLAIM_MARGIN_S;

export const GITHUB_URL = "https://github.com/DigitalGuards/QuantaSwap";
