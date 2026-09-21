import { QRL_LEG } from "../config";

export type QrlRead = (method: string, params: unknown[]) => Promise<unknown>;

/** Recheck each operation. A provider or RPC can change networks at runtime. */
export async function assertQrlNetwork(read: QrlRead): Promise<void> {
  const [chain, genesis] = await Promise.all([
    read("qrl_chainId", []),
    read("qrl_getBlockByNumber", ["0x0", false]),
  ]);
  if (typeof chain !== "string" || !/^(?:0x[0-9a-fA-F]+|[0-9]+)$/.test(chain) ||
      BigInt(chain) !== BigInt(QRL_LEG.chainIdHex)) {
    throw new Error("QRL provider chain identity mismatch; select Testnet v3 (Private)");
  }
  if (typeof genesis !== "object" || genesis === null ||
      !("hash" in genesis) || typeof genesis.hash !== "string" ||
      genesis.hash.toLowerCase() !== QRL_LEG.genesisHash.toLowerCase() ||
      !("number" in genesis) || genesis.number !== "0x0") {
    throw new Error("QRL provider genesis identity mismatch");
  }
}
