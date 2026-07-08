// Read/encode helpers for the HTLC deployed on both legs. Reads go through
// plain JSON-RPC (qrl_* namespace for the QRL leg, eth_* for Sepolia);
// writes are encoded here and signed by the user's wallets.

import { Interface } from "ethers";
import { ETH_LEG, QRL_LEG, type LegKey } from "../config";

export const HTLC_ABI = [
  "function lockNative(bytes32 hashlock, address recipient, uint256 timeout) payable",
  "function lockToken(bytes32 hashlock, address recipient, address token, uint256 amount, uint256 timeout)",
  "function claim(bytes32 hashlock, bytes32 preimage)",
  "function refund(bytes32 hashlock)",
  "function getSwap(bytes32 hashlock) view returns (tuple(address initiator, address recipient, address token, uint256 amount, uint256 timeout, uint8 status, bytes32 preimage))",
];

export const htlcInterface = new Interface(HTLC_ABI);

export const SwapStatus = { None: 0, Open: 1, Claimed: 2, Refunded: 3 } as const;
export type SwapStatusValue = (typeof SwapStatus)[keyof typeof SwapStatus];

export interface LegState {
  status: SwapStatusValue;
  initiator: string;
  recipient: string;
  amount: bigint;
  timeout: number;
  preimage: string;
}

/** QRL v2 uses Q-prefixed 20-byte addresses; calldata wants raw hex. */
export const qToHex = (addr: string): string =>
  addr.startsWith("Q") || addr.startsWith("Z") ? `0x${addr.slice(1)}` : addr;

export const hexToQ = (addr: string): string =>
  addr.startsWith("0x") ? `Q${addr.slice(2)}` : addr;

async function rpc(url: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`RPC ${method} failed: HTTP ${res.status}`);
  const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(body.error.message ?? `RPC ${method} error`);
  return body.result;
}

export const qrlRpc = (method: string, params: unknown[]) => rpc(QRL_LEG.rpc, method, params);
export const ethRpc = (method: string, params: unknown[]) => rpc(ETH_LEG.rpc, method, params);

export async function getLegState(leg: LegKey, hashlock: string): Promise<LegState> {
  const data = htlcInterface.encodeFunctionData("getSwap", [hashlock]);
  const call =
    leg === "qrl"
      ? qrlRpc("qrl_call", [{ to: QRL_LEG.htlc, data }, "latest"])
      : ethRpc("eth_call", [{ to: ETH_LEG.htlc, data }, "latest"]);
  const raw = (await call) as string;
  const [swap] = htlcInterface.decodeFunctionResult("getSwap", raw) as unknown as [
    {
      initiator: string;
      recipient: string;
      token: string;
      amount: bigint;
      timeout: bigint;
      status: bigint;
      preimage: string;
    },
  ];
  return {
    status: Number(swap.status) as SwapStatusValue,
    initiator: swap.initiator,
    recipient: swap.recipient,
    amount: swap.amount,
    timeout: Number(swap.timeout),
    preimage: swap.preimage,
  };
}

export async function getBlockNumber(leg: LegKey): Promise<number> {
  const method = leg === "qrl" ? "qrl_blockNumber" : "eth_blockNumber";
  const fn = leg === "qrl" ? qrlRpc : ethRpc;
  return Number(BigInt((await fn(method, [])) as string));
}

export const buildLockNativeData = (hashlock: string, recipient: string, timeout: number): string =>
  htlcInterface.encodeFunctionData("lockNative", [hashlock, qToHex(recipient), timeout]);

export const buildClaimData = (hashlock: string, preimage: string): string =>
  htlcInterface.encodeFunctionData("claim", [hashlock, preimage]);

export const buildRefundData = (hashlock: string): string =>
  htlcInterface.encodeFunctionData("refund", [hashlock]);

export const shortAddr = (addr: string): string =>
  addr.length > 12 ? `${addr.slice(0, 8)}…${addr.slice(-4)}` : addr;
