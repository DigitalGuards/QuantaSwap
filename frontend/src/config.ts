export const QRL_LEG = {
  key: "qrl" as const,
  name: "QRL v2 testnet",
  asset: "QRL",
  chainIdHex: "0x539",
  htlc: "Q94cd8e406d2bb4ea251dce3f0558941f2ac056ee",
  rpc: "/rpc/qrl",
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
  explorerTx: "https://sepolia.etherscan.io/tx/",
  explorerAddress: "https://sepolia.etherscan.io/address/",
};

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
