// HTLC reads and calldata for both legs over plain JSON-RPC, mirroring
// frontend/src/lib/htlc.ts. Chain state is the only trusted input: the
// order book coordinates, the chain decides.

import { Interface } from "ethers";

export const HTLC_ABI = [
  "function lockNative(bytes32 hashlock, address recipient, uint256 timeout) payable",
  "function claim(bytes32 hashlock, bytes32 preimage)",
  "function refund(bytes32 hashlock)",
  "function getSwap(bytes32 hashlock) view returns (tuple(address initiator, address recipient, address token, uint256 amount, uint256 timeout, uint8 status, bytes32 preimage))",
];

const iface = new Interface(HTLC_ABI);

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

export type LegKey = "eth" | "qrl";

export const qToHex = (addr: string): string =>
  addr.startsWith("Q") || addr.startsWith("Z") ? `0x${addr.slice(1)}` : addr;

export const sameAddr = (a: string, b: string): boolean =>
  qToHex(a).toLowerCase() === qToHex(b).toLowerCase();

export async function rpc(url: string, method: string, params: unknown[]): Promise<unknown> {
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

export interface LegRpc {
  url: string;
  /** RPC namespace prefix: "eth" on Sepolia, "qrl" on QRL v2. */
  ns: LegKey;
  htlc: string;
}

export async function getBlockNumber(leg: LegRpc): Promise<number> {
  return Number(BigInt((await rpc(leg.url, `${leg.ns}_blockNumber`, [])) as string));
}

export async function getSwapState(
  leg: LegRpc,
  hashlock: string,
  blockTag = "latest",
): Promise<LegState> {
  const data = iface.encodeFunctionData("getSwap", [hashlock]);
  const raw = (await rpc(leg.url, `${leg.ns}_call`, [{ to: leg.htlc, data }, blockTag])) as string;
  const [swap] = iface.decodeFunctionResult("getSwap", raw) as unknown as [
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

/** State `confirmations` blocks behind the head: the trust gate for
 *  irreversible responses, identical to the frontend's. */
export async function getConfirmedSwapState(
  leg: LegRpc,
  hashlock: string,
  confirmations: number,
): Promise<LegState> {
  const head = await getBlockNumber(leg);
  const depth = Math.max(0, head - confirmations);
  return getSwapState(leg, hashlock, `0x${depth.toString(16)}`);
}

export const encodeLock = (hashlock: string, recipient: string, timeout: number): string =>
  iface.encodeFunctionData("lockNative", [hashlock, qToHex(recipient), timeout]);

export const encodeClaim = (hashlock: string, preimage: string): string =>
  iface.encodeFunctionData("claim", [hashlock, preimage]);

export const encodeRefund = (hashlock: string): string =>
  iface.encodeFunctionData("refund", [hashlock]);
