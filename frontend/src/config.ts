// `confirmations`: block depth a counterparty lock must reach before this
// client acts on it irreversibly (taker locking, maker revealing the
// secret). Depth 1 is sized for testnet demo patience (~40s on QRL's
// ~40s blocks, ~12s on Sepolia); production should gate on the
// `finalized` tag instead (ARCHITECTURE section 2 sizes the timelock
// margins for full ~13 min finality).
export const QRL_LEG = {
  key: "qrl" as const,
  name: "QRL v2 testnet",
  asset: "QRL",
  chainIdHex: "0x539",
  htlc: "Q94cd8e406d2bb4ea251dce3f0558941f2ac056ee",
  rpc: "/rpc/qrl",
  confirmations: 1,
  explorerTx: "https://zondscan.com/tx/",
  explorerAddress: "https://zondscan.com/address/",
};

export const ETH_LEG = {
  key: "eth" as const,
  name: "Sepolia",
  asset: "ETH",
  chainIdHex: "0xaa36a7",
  htlc: "0x805100Fa4310B9c0dbb0754E14CbDe827E3b8a3c",
  rpc: "/rpc/sepolia",
  confirmations: 1,
  explorerTx: "https://sepolia.etherscan.io/tx/",
  explorerAddress: "https://sepolia.etherscan.io/address/",
};

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

// Dust guard for orders; mirrored server-side in server/src/store.ts.
export const MIN_AMOUNT_WEI = 10n ** 15n;

// A taker only locks if the maker's timeout leaves at least this much
// claim window beyond the responder timeout.
export const CLAIM_MARGIN_S = 30 * 60;

export const GITHUB_URL = "https://github.com/DigitalGuards/QuantaSwap";
