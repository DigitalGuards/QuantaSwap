// HTLC reads and calldata for both legs over plain JSON-RPC, mirroring
// frontend/src/lib/htlc.ts. Chain state is the only trusted input: the
// order book coordinates, the chain decides.

import { Interface } from "ethers";

export const HTLC_ABI = [
  "function lockNative(bytes32 hashlock, address recipient, uint256 timeout) payable",
  "function lockToken(bytes32 hashlock, address recipient, address token, uint256 amount, uint256 timeout)",
  "function claim(bytes32 hashlock, bytes32 preimage)",
  "function refund(bytes32 hashlock)",
  "function getSwap(bytes32 hashlock) view returns (tuple(address initiator, address recipient, address token, uint256 amount, uint256 timeout, uint8 status, bytes32 preimage))",
];

/** Minimal ERC-20 surface for the token leg. approve is declared with no
 *  return value on purpose: USDT-style tokens return no data, so the
 *  maker sends raw calldata and trusts the receipt status only, never a
 *  decoded return value. */
export const ERC20_ABI = [
  "function approve(address spender, uint256 amount)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address holder) view returns (uint256)",
];

const iface = new Interface(HTLC_ABI);
const erc20 = new Interface(ERC20_ABI);

export const SwapStatus = { None: 0, Open: 1, Claimed: 2, Refunded: 3 } as const;
export type SwapStatusValue = (typeof SwapStatus)[keyof typeof SwapStatus];

/** The native-coin sentinel in the HTLC's `token` field (address(0)). */
export const NATIVE_TOKEN = `0x${"0".repeat(40)}`;

export interface LegState {
  status: SwapStatusValue;
  initiator: string;
  recipient: string;
  /** ERC-20 escrowed, or the zero address for native coin. lockNative()
   *  and lockToken() records share the struct, so a counterparty lock is
   *  claimable ONLY when this equals the exact token address expected for
   *  the agreed asset (the native sentinel for native legs): a lock with
   *  the right recipient and amount but the wrong token pays out a
   *  worthless balance on claim. */
  token: string;
  amount: bigint;
  timeout: number;
  preimage: string;
}

export type LegKey = "eth" | "qrl";

export const qToHex = (addr: string): string =>
  addr.startsWith("Q") || addr.startsWith("Z") ? `0x${addr.slice(1)}` : addr;

export const sameAddr = (a: string, b: string): boolean =>
  qToHex(a).toLowerCase() === qToHex(b).toLowerCase();

/** Bounds a single JSON-RPC request; without it a stalling endpoint hangs
 *  the whole single-threaded tick forever. */
const DEFAULT_RPC_TIMEOUT_MS = 20_000;

export async function rpc(
  url: string,
  method: string,
  params: unknown[],
  timeoutMs = DEFAULT_RPC_TIMEOUT_MS,
): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
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
  /** Per-request deadline; defaults to DEFAULT_RPC_TIMEOUT_MS. */
  timeoutMs?: number;
}

export async function getBlockNumber(leg: LegRpc): Promise<number> {
  return Number(BigInt((await rpc(leg.url, `${leg.ns}_blockNumber`, [], leg.timeoutMs)) as string));
}

export async function getSwapState(
  leg: LegRpc,
  hashlock: string,
  blockTag = "latest",
): Promise<LegState> {
  const data = iface.encodeFunctionData("getSwap", [hashlock]);
  const raw = (await rpc(
    leg.url,
    `${leg.ns}_call`,
    [{ to: leg.htlc, data }, blockTag],
    leg.timeoutMs,
  )) as string;
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
    token: swap.token,
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

/** lockToken calldata: value rides in the calldata (msg.value 0) after an
 *  exact-amount approval. */
export const encodeLockToken = (
  hashlock: string,
  recipient: string,
  token: string,
  amount: bigint,
  timeout: number,
): string =>
  iface.encodeFunctionData("lockToken", [hashlock, qToHex(recipient), token, amount, timeout]);

export const encodeApprove = (spender: string, amount: bigint): string =>
  erc20.encodeFunctionData("approve", [spender, amount]);

/** Current allowance(owner, spender) on `token`; a plain eth_call read,
 *  safe to decode for every token (the no-return-data quirk applies to
 *  approve/transfer writes only). */
export async function erc20Allowance(
  leg: LegRpc,
  token: string,
  owner: string,
  spender: string,
): Promise<bigint> {
  const data = erc20.encodeFunctionData("allowance", [owner, spender]);
  const raw = (await rpc(
    leg.url,
    `${leg.ns}_call`,
    [{ to: token, data }, "latest"],
    leg.timeoutMs,
  )) as string;
  const [value] = erc20.decodeFunctionResult("allowance", raw) as unknown as [bigint];
  return value;
}

export async function erc20BalanceOf(leg: LegRpc, token: string, holder: string): Promise<bigint> {
  const data = erc20.encodeFunctionData("balanceOf", [holder]);
  const raw = (await rpc(
    leg.url,
    `${leg.ns}_call`,
    [{ to: token, data }, "latest"],
    leg.timeoutMs,
  )) as string;
  const [value] = erc20.decodeFunctionResult("balanceOf", raw) as unknown as [bigint];
  return value;
}

export const encodeClaim = (hashlock: string, preimage: string): string =>
  iface.encodeFunctionData("claim", [hashlock, preimage]);

export const encodeRefund = (hashlock: string): string =>
  iface.encodeFunctionData("refund", [hashlock]);
