export const QRL_LEG = {
  key: "qrl" as const,
  name: "QRL v2 testnet",
  asset: "QRL",
  chainIdHex: "0x539",
  htlc: "Q94cd8e406d2bb4ea251dce3f0558941f2ac056ee",
  rpc: "/rpc/qrl",
  explorerTx: "https://zondscan.com/tx/",
};

export const ETH_LEG = {
  key: "eth" as const,
  name: "Sepolia",
  asset: "ETH",
  chainIdHex: "0xaa36a7",
  htlc: "0x805100Fa4310B9c0dbb0754E14CbDe827E3b8a3c",
  rpc: "/rpc/sepolia",
  explorerTx: "https://sepolia.etherscan.io/tx/",
};

export type LegKey = "qrl" | "eth";

export const legByKey = (key: LegKey) => (key === "qrl" ? QRL_LEG : ETH_LEG);

// Demo timelocks. Real protocol-mode matching will size these per pair;
// the invariant is initiator >= 2x responder.
export const INITIATOR_TIMEOUT_S = 2 * 3600;
export const RESPONDER_TIMEOUT_S = 1 * 3600;

export const GITHUB_URL = "https://github.com/DigitalGuards/QuantaSwap";
