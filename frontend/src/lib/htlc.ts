// Read/encode helpers for the HTLC deployed on both legs. Reads go through
// plain JSON-RPC (qrl_* namespace for the QRL leg, eth_* for Sepolia);
// writes are encoded here and signed by the user's wallets.

import { Interface } from "ethers";
import { ETH_LEG, ETH_LOGS_RPC, QRL_LEG, legByKey, type LegKey } from "../config";
import { qToHex } from "./qrlAddress";

export { hexToQ, qToHex } from "./qrlAddress";

export const HTLC_ABI = [
  "function lockNative(bytes32 hashlock, address recipient, uint256 timeout) payable",
  "function lockToken(bytes32 hashlock, address recipient, address token, uint256 amount, uint256 timeout)",
  // HTLCv2 open-recipient locks (prelock): escrow with the recipient
  // unset, fix it later with one-time assign(), or reclaim on demand with
  // release() while still unassigned (release emits Refunded).
  "function lockNativeOpen(bytes32 hashlock, uint256 timeout) payable",
  "function lockTokenOpen(bytes32 hashlock, address token, uint256 amount, uint256 timeout)",
  "function assign(bytes32 hashlock, address recipient)",
  "function release(bytes32 hashlock)",
  "function claim(bytes32 hashlock, bytes32 preimage)",
  "function refund(bytes32 hashlock)",
  "function getSwap(bytes32 hashlock) view returns (tuple(address initiator, address recipient, address token, uint256 amount, uint256 timeout, uint8 status, bytes32 preimage))",
  "event Locked(bytes32 indexed hashlock, address indexed initiator, address indexed recipient, address token, uint256 amount, uint256 timeout)",
  "event Assigned(bytes32 indexed hashlock, address indexed recipient)",
  "event Claimed(bytes32 indexed hashlock, bytes32 preimage, address caller)",
  "event Refunded(bytes32 indexed hashlock)",
];

export const htlcInterface = new Interface(HTLC_ABI);

// Minimal ERC-20 surface for the token lock flow. `approve` is declared
// WITHOUT a return type on purpose: USDT-style tokens (tUSDT here, quirk
// noReturnValue) return no data from approve/transfer, so callers must
// never decode approve return data; success is judged by the receipt
// status alone. The selector is identical either way (return types are
// not part of the selector).
export const ERC20_ABI = [
  "function approve(address spender, uint256 amount)",
  "function allowance(address owner, address spender) view returns (uint256)",
];

export const erc20Interface = new Interface(ERC20_ABI);

export const SwapStatus = { None: 0, Open: 1, Claimed: 2, Refunded: 3 } as const;
export type SwapStatusValue = (typeof SwapStatus)[keyof typeof SwapStatus];

export interface LegState {
  status: SwapStatusValue;
  initiator: string;
  recipient: string;
  /** ERC-20 address escrowed, or the zero address for the native coin. A
   *  swap is only honest when this is native: a lockToken() record shares
   *  the same struct and would otherwise pass every recipient/amount check
   *  while paying out a worthless token on claim. */
  token: string;
  amount: bigint;
  timeout: number;
  preimage: string;
}

/** The native-coin sentinel in the HTLC's `token` field (address(0)). */
export const NATIVE_TOKEN = `0x${"0".repeat(40)}`;

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

export async function getLegState(
  leg: LegKey,
  hashlock: string,
  blockTag = "latest",
): Promise<LegState> {
  const data = htlcInterface.encodeFunctionData("getSwap", [hashlock]);
  const call =
    leg === "qrl"
      ? qrlRpc("qrl_call", [{ to: QRL_LEG.htlc, data }, blockTag])
      : ethRpc("eth_call", [{ to: ETH_LEG.htlc, data }, blockTag]);
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
    token: swap.token,
    amount: swap.amount,
    timeout: Number(swap.timeout),
    preimage: swap.preimage,
  };
}

/** Pure depth arithmetic for the confirmed snapshot: the block a lock
 *  must be visible at, `confirmations` behind the head, clamped at
 *  genesis. 0 reads the head block itself. */
export const confirmedBlock = (head: number, confirmations: number): number =>
  Math.max(0, head - confirmations);

/** The swap struct as it looked `confirmations` blocks behind the head.
 *  Irreversible responses (locking the other leg, revealing the secret)
 *  only trust a lock once it is visible at this depth. The reorg
 *  protection is exactly as strong as the configured depth: 0 trusts
 *  the head block, so a 1-block reorg can drop a lock this snapshot
 *  just reported (accepted for testnet speed, see config.ts; mainnet
 *  gates on the `finalized` tag). The struct is immutable once created
 *  (hashlock freshness is enforced by the contract), so a confirmed
 *  snapshot's fields are canonical. */
export async function getConfirmedLegState(leg: LegKey, hashlock: string): Promise<LegState> {
  const head = await getBlockNumber(leg);
  const depth = confirmedBlock(head, legByKey(leg).confirmations);
  return getLegState(leg, hashlock, `0x${depth.toString(16)}`);
}

export async function getBlockNumber(leg: LegKey): Promise<number> {
  const method = leg === "qrl" ? "qrl_blockNumber" : "eth_blockNumber";
  const fn = leg === "qrl" ? qrlRpc : ethRpc;
  return Number(BigInt((await fn(method, [])) as string));
}

export type SwapEventKind = "locked" | "assigned" | "claimed" | "refunded";

export interface SwapEvent {
  kind: SwapEventKind;
  txHash: string;
}

function eventTopic(name: string): string {
  const frag = htlcInterface.getEvent(name);
  if (frag === null) throw new Error(`unknown HTLC event ${name}`);
  return frag.topicHash;
}

const TOPIC_KIND: ReadonlyMap<string, SwapEventKind> = new Map([
  [eventTopic("Locked"), "locked"],
  [eventTopic("Assigned"), "assigned"],
  [eventTopic("Claimed"), "claimed"],
  [eventTopic("Refunded"), "refunded"],
]);

/** Every HTLC action (both parties') indexed by the shared hashlock, with
 *  its transaction hash for explorer links. Chain-derived, so it works
 *  for any visitor with no order-book record and no wallet. Both legs
 *  scan from genesis: the QRL node is ours, and the ETH side uses the
 *  logs-capable proxy (the main Sepolia RPC refuses log scans). */
export async function getSwapEvents(leg: LegKey, hashlock: string): Promise<SwapEvent[]> {
  const cfg = legByKey(leg);
  const params = [
    { address: cfg.htlc, topics: [null, hashlock], fromBlock: "0x0", toBlock: "latest" },
  ];
  const raw = await (leg === "qrl"
    ? qrlRpc("qrl_getLogs", params)
    : rpc(ETH_LOGS_RPC, "eth_getLogs", params));
  if (!Array.isArray(raw)) return [];
  const events: SwapEvent[] = [];
  for (const entry of raw as unknown[]) {
    if (typeof entry !== "object" || entry === null) continue;
    const log = entry as { topics?: unknown; transactionHash?: unknown };
    const topic0 =
      Array.isArray(log.topics) && typeof log.topics[0] === "string" ? log.topics[0] : null;
    const kind = topic0 === null ? undefined : TOPIC_KIND.get(topic0);
    if (kind === undefined || typeof log.transactionHash !== "string") continue;
    events.push({ kind, txHash: log.transactionHash });
  }
  return events;
}

export const buildLockNativeData = (hashlock: string, recipient: string, timeout: number): string =>
  htlcInterface.encodeFunctionData("lockNative", [hashlock, qToHex(recipient), timeout]);

/** ERC-20 escrow lock: the amount rides in calldata (msg.value must be 0)
 *  and the HTLC pulls the tokens via transferFrom, so the exact-amount
 *  allowance must already be in place. */
export const buildLockTokenData = (
  hashlock: string,
  recipient: string,
  token: string,
  amount: bigint,
  timeout: number,
): string =>
  htlcInterface.encodeFunctionData("lockToken", [hashlock, qToHex(recipient), token, amount, timeout]);

/** approve(spender, amount) calldata; sent to the TOKEN contract, not the
 *  HTLC. Raw calldata by design: see the noReturnValue note on ERC20_ABI. */
export const buildApproveData = (spender: string, amount: bigint): string =>
  erc20Interface.encodeFunctionData("approve", [spender, amount]);

/** Current allowance(owner, spender) on an ERC-20, read via eth_call on
 *  the Sepolia leg. Used to skip an already-exact approval (crash-resume
 *  idempotency) and to detect a stale nonzero allowance that approvalRace
 *  tokens require resetting to 0 first. */
export async function allowanceOf(token: string, owner: string, spender: string): Promise<bigint> {
  const data = erc20Interface.encodeFunctionData("allowance", [owner, spender]);
  const raw = (await ethRpc("eth_call", [{ to: token, data }, "latest"])) as string;
  const [value] = erc20Interface.decodeFunctionResult("allowance", raw) as unknown as [bigint];
  return value;
}

export const buildClaimData = (hashlock: string, preimage: string): string =>
  htlcInterface.encodeFunctionData("claim", [hashlock, preimage]);

export const buildRefundData = (hashlock: string): string =>
  htlcInterface.encodeFunctionData("refund", [hashlock]);

/** Open-recipient (prelock) escrow: no recipient in the calldata; it is
 *  fixed later by assign(). */
export const buildLockNativeOpenData = (hashlock: string, timeout: number): string =>
  htlcInterface.encodeFunctionData("lockNativeOpen", [hashlock, timeout]);

export const buildLockTokenOpenData = (
  hashlock: string,
  token: string,
  amount: bigint,
  timeout: number,
): string => htlcInterface.encodeFunctionData("lockTokenOpen", [hashlock, token, amount, timeout]);

/** One-time, initiator-only recipient assignment on an open lock. */
export const buildAssignData = (hashlock: string, recipient: string): string =>
  htlcInterface.encodeFunctionData("assign", [hashlock, qToHex(recipient)]);

/** On-demand escrow reclaim, valid only while the lock is unassigned. */
export const buildReleaseData = (hashlock: string): string =>
  htlcInterface.encodeFunctionData("release", [hashlock]);

export const shortAddr = (addr: string): string =>
  addr.length > 12 ? `${addr.slice(0, 8)}…${addr.slice(-4)}` : addr;
