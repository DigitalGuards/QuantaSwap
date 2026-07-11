// Read/encode helpers for the HTLC deployed on both legs. Reads go through
// plain JSON-RPC (qrl_* namespace for the QRL leg, eth_* for Sepolia);
// writes are encoded here and signed by the user's wallets.

import { Interface } from "ethers";
import { ETH_LEG, ETH_LOGS_RPC, QRL_LEG, legByKey, type LegKey } from "../config";

export const HTLC_ABI = [
  "function lockNative(bytes32 hashlock, address recipient, uint256 timeout) payable",
  "function lockToken(bytes32 hashlock, address recipient, address token, uint256 amount, uint256 timeout)",
  "function claim(bytes32 hashlock, bytes32 preimage)",
  "function refund(bytes32 hashlock)",
  "function getSwap(bytes32 hashlock) view returns (tuple(address initiator, address recipient, address token, uint256 amount, uint256 timeout, uint8 status, bytes32 preimage))",
  "event Locked(bytes32 indexed hashlock, address indexed initiator, address indexed recipient, address token, uint256 amount, uint256 timeout)",
  "event Claimed(bytes32 indexed hashlock, bytes32 preimage, address caller)",
  "event Refunded(bytes32 indexed hashlock)",
];

export const htlcInterface = new Interface(HTLC_ABI);

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

/** The swap struct as it looked `confirmations` blocks behind the head.
 *  A lock is only trustworthy for irreversible responses (locking the
 *  other leg, revealing the secret) once it is visible at this depth; a
 *  shallow reorg cannot rewrite it out from under the counterparty. The
 *  struct is immutable once created (hashlock freshness is enforced by
 *  the contract), so the confirmed snapshot's fields are canonical. */
export async function getConfirmedLegState(leg: LegKey, hashlock: string): Promise<LegState> {
  const head = await getBlockNumber(leg);
  const depth = Math.max(0, head - legByKey(leg).confirmations);
  return getLegState(leg, hashlock, `0x${depth.toString(16)}`);
}

export async function getBlockNumber(leg: LegKey): Promise<number> {
  const method = leg === "qrl" ? "qrl_blockNumber" : "eth_blockNumber";
  const fn = leg === "qrl" ? qrlRpc : ethRpc;
  return Number(BigInt((await fn(method, [])) as string));
}

export type SwapEventKind = "locked" | "claimed" | "refunded";

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

export const buildClaimData = (hashlock: string, preimage: string): string =>
  htlcInterface.encodeFunctionData("claim", [hashlock, preimage]);

export const buildRefundData = (hashlock: string): string =>
  htlcInterface.encodeFunctionData("refund", [hashlock]);

export const shortAddr = (addr: string): string =>
  addr.length > 12 ? `${addr.slice(0, 8)}…${addr.slice(-4)}` : addr;
