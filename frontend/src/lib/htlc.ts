// Read/encode helpers for the HTLC deployed on both legs. Reads go through
// plain JSON-RPC (qrl_* namespace for the QRL leg, eth_* for Sepolia);
// writes are encoded here and signed by the user's wallets.

import { Interface } from "ethers";
import { ETH_LEG, ETH_LOGS_RPC, QRL_LEG, legByKey, type LegKey } from "../config";
import { formatQrlAddressFingerprint, isQrlAddress, qToHex } from "./qrlAddress";
import { decodeQrvmSwap, decodeQrvmUints, encodeQrvmHtlc } from "./qrvmHtlc";
import { assertQrlNetwork } from "./qrlNetwork";
import {
  assertQip55ReadReady,
  QRVM_ZERO_ADDRESS,
} from "./qip55";

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
  // HTLCv3 payout credits. A settlement whose delivery fails is still
  // terminal: the amount becomes a credit owned by the payee, which only
  // that payee can redirect (withdraw/withdrawAll) and which anyone can
  // deliver to the payee itself (pushCredit).
  "function withdraw(address token, address to, uint256 amount)",
  "function withdrawAll(address token, address to)",
  "function pushCredit(address token, address account)",
  "function creditOf(address token, address account) view returns (uint256)",
  "function outstandingCredit(address token) view returns (uint256)",
  "function deliveryGasPolicy() view returns (uint256 gasLimit, uint256 gasReserve)",
  "event Locked(bytes32 indexed hashlock, address indexed initiator, address indexed recipient, address token, uint256 amount, uint256 timeout)",
  "event Assigned(bytes32 indexed hashlock, address indexed recipient)",
  "event Claimed(bytes32 indexed hashlock, bytes32 preimage, address caller)",
  "event Refunded(bytes32 indexed hashlock)",
  "event PayoutCredited(address indexed token, address indexed account, bytes32 indexed hashlock, uint256 amount)",
  "event PayoutWithdrawn(address indexed token, address indexed account, address to, uint256 amount)",
];

/** The HTLCv3 delivery budget and credit reserve, mirrored from
 *  contracts/hyperion/HTLCv3.hyp and published on chain by
 *  deliveryGasPolicy(). */
export const DELIVERY_GAS_LIMIT = 100_000n;
export const DELIVERY_GAS_RESERVE = 150_000n;

/** The settlement gas rule from docs/audit/HTLCV3_SCOPE.md (A1, A2): send
 *  claim, refund and release with `estimateGas + DELIVERY_GAS_LIMIT +
 *  DELIVERY_GAS_RESERVE`. Gas estimation minimises gas and the credit path
 *  is cheaper than a real transfer, so a bare estimate defers a payout that
 *  would have gone straight through. Unused gas is refunded, so the buffer
 *  costs only transaction-limit headroom. */
export const SETTLEMENT_GAS_BUFFER = DELIVERY_GAS_LIMIT + DELIVERY_GAS_RESERVE;

export const settlementGasLimit = (estimate: bigint): bigint =>
  estimate + SETTLEMENT_GAS_BUFFER;

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

/** Ethereum address(0). QRL QRVM64 uses QRL_NATIVE_TOKEN. */
export const NATIVE_TOKEN = `0x${"0".repeat(40)}`;
export const QRL_NATIVE_TOKEN = QRVM_ZERO_ADDRESS;

export const nativeTokenForLeg = (leg: LegKey): string =>
  leg === "qrl" ? QRL_NATIVE_TOKEN : NATIVE_TOKEN;

async function rpc(url: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(20_000),
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`RPC ${method} failed: HTTP ${res.status}`);
  const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(body.error.message ?? `RPC ${method} error`);
  return body.result;
}

export const qrlRpc = async (method: string, params: unknown[]): Promise<unknown> => {
  await assertQrlNetwork((identityMethod, identityParams) => rpc(QRL_LEG.rpc, identityMethod, identityParams));
  return rpc(QRL_LEG.rpc, method, params);
};
export const ethRpc = (method: string, params: unknown[]) => rpc(ETH_LEG.rpc, method, params);

export async function getLegState(
  leg: LegKey,
  hashlock: string,
  blockTag = "latest",
): Promise<LegState> {
  if (leg === "qrl") assertQip55ReadReady(QRL_LEG.htlc);
  if (leg === "qrl") {
    return decodeQrvmSwap(await qrlRpc("qrl_call", [
      { to: QRL_LEG.htlc, data: encodeQrvmHtlc("getSwap", [hashlock]) },
      blockTag,
    ]));
  }
  const data = htlcInterface.encodeFunctionData("getSwap", [hashlock]);
  const call = ethRpc("eth_call", [{ to: ETH_LEG.htlc, data }, blockTag]);
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

/** Undelivered payout owned by `account` in `token` on this leg. Zero for
 *  every swap whose payout was delivered, which is the normal case. */
export async function getCredit(leg: LegKey, token: string, account: string): Promise<bigint> {
  if (leg === "qrl") {
    assertQip55ReadReady(QRL_LEG.htlc);
    const raw = await qrlRpc("qrl_call", [
      { to: QRL_LEG.htlc, data: encodeQrvmHtlc("creditOf", [token, account]) },
      "latest",
    ]);
    return decodeQrvmUints(raw, 1)[0] ?? 0n;
  }
  const data = htlcInterface.encodeFunctionData("creditOf", [token, qToHex(account)]);
  const raw = (await ethRpc("eth_call", [{ to: ETH_LEG.htlc, data }, "latest"])) as string;
  const [value] = htlcInterface.decodeFunctionResult("creditOf", raw) as unknown as [bigint];
  return value;
}

export interface DeliveryGasPolicy {
  gasLimit: bigint;
  gasReserve: bigint;
}

/** The deployed contract's own delivery budget and credit reserve. Only
 *  HTLCv3 answers this call, so a successful read is also proof that the
 *  configured address is the interface this build settles against. */
export async function getDeliveryGasPolicy(leg: LegKey): Promise<DeliveryGasPolicy> {
  if (leg === "qrl") {
    assertQip55ReadReady(QRL_LEG.htlc);
    const raw = await qrlRpc("qrl_call", [
      { to: QRL_LEG.htlc, data: encodeQrvmHtlc("deliveryGasPolicy", []) },
      "latest",
    ]);
    const [gasLimit, gasReserve] = decodeQrvmUints(raw, 2);
    return { gasLimit: gasLimit ?? 0n, gasReserve: gasReserve ?? 0n };
  }
  const data = htlcInterface.encodeFunctionData("deliveryGasPolicy", []);
  const raw = (await ethRpc("eth_call", [{ to: ETH_LEG.htlc, data }, "latest"])) as string;
  const [gasLimit, gasReserve] = htlcInterface.decodeFunctionResult(
    "deliveryGasPolicy",
    raw,
  ) as unknown as [bigint, bigint];
  return { gasLimit, gasReserve };
}

const policyChecked = new Map<LegKey, Promise<void>>();

/** Confirm per leg that the deployed contract publishes the budget this
 *  build's settlement gas rule is built from. A mismatch fails closed: the
 *  rule would then be wrong and every deferred payout on that leg would be a
 *  surprise. A read that cannot complete leaves the question open and lets
 *  the settlement through, because the pinned `htlcInterface` field in
 *  config/protocol-v2.json already refuses a profile from the wrong contract
 *  generation. Only a completed check is remembered, so a settlement during
 *  an RPC outage does not retire the guard for the rest of the session. */
export function assertDeliveryGasPolicy(leg: LegKey): Promise<void> {
  const pending = policyChecked.get(leg);
  if (pending !== undefined) return pending;
  const check = getDeliveryGasPolicy(leg).then(
    (policy) => {
      if (policy.gasLimit !== DELIVERY_GAS_LIMIT || policy.gasReserve !== DELIVERY_GAS_RESERVE) {
        throw new Error(
          `The ${leg} HTLC publishes a delivery budget this client was not built for; refusing to settle`,
        );
      }
    },
    () => {
      policyChecked.delete(leg);
    },
  );
  policyChecked.set(leg, check);
  return check;
}

/** Test seam: forget the per-session delivery-policy verdicts. */
export const resetDeliveryGasPolicyCache = (): void => {
  policyChecked.clear();
};

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
  if (leg === "qrl") assertQip55ReadReady(QRL_LEG.htlc);
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

/** QRVM64 log topics are 64-byte ABI words. A bytes32 signature or
 * indexed hash occupies the high half, followed by 32 zero bytes. */
export function qrvm64Topic(word: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(word)) {
    throw new Error("QRVM64 topic source must be exactly 32 bytes");
  }
  return `${word.toLowerCase()}${"0".repeat(64)}`;
}

const QRL_TOPIC_KIND: ReadonlyMap<string, SwapEventKind> = new Map([
  [qrvm64Topic(eventTopic("Locked")), "locked"],
  [qrvm64Topic(eventTopic("Assigned")), "assigned"],
  [qrvm64Topic(eventTopic("Claimed")), "claimed"],
  [qrvm64Topic(eventTopic("Refunded")), "refunded"],
]);

export function swapEventKindFromTopic(
  leg: LegKey,
  topic: string,
): SwapEventKind | undefined {
  return (leg === "qrl" ? QRL_TOPIC_KIND : TOPIC_KIND).get(topic.toLowerCase());
}

/** Every HTLC action (both parties') indexed by the shared hashlock, with
 *  its transaction hash for explorer links. Chain-derived, so it works
 *  for any visitor with no order-book record and no wallet. Both legs
 *  scan from genesis: the QRL node is ours, and the ETH side uses the
 *  logs-capable proxy (the main Sepolia RPC refuses log scans). */
export async function getSwapEvents(leg: LegKey, hashlock: string): Promise<SwapEvent[]> {
  // Only the qualified full-width deployment accepts QRL reads.
  if (leg === "qrl") assertQip55ReadReady(QRL_LEG.htlc);
  const cfg = legByKey(leg);
  const params = [
    {
      address: cfg.htlc,
      topics: [null, leg === "qrl" ? qrvm64Topic(hashlock) : hashlock],
      fromBlock: "0x0",
      toBlock: "latest",
    },
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
    const kind =
      topic0 === null
        ? undefined
        : swapEventKindFromTopic(leg, topic0);
    if (kind === undefined || typeof log.transactionHash !== "string") continue;
    events.push({ kind, txHash: log.transactionHash });
  }
  return events;
}

function assertEthersAddressRecipient(recipient: string): void {
  if (isQrlAddress(recipient)) throw new Error("The Ethereum leg requires a 20-byte Ethereum recipient");
}

function assertLegCalldataReady(leg: LegKey): void {
  if (leg === "qrl") assertQip55ReadReady(QRL_LEG.htlc);
}

export const buildLockNativeData = (
  leg: LegKey,
  hashlock: string,
  recipient: string,
  timeout: number,
): string => {
  assertLegCalldataReady(leg);
  if (leg === "qrl") return encodeQrvmHtlc("lockNative", [hashlock, recipient, timeout]);
  assertEthersAddressRecipient(recipient);
  return htlcInterface.encodeFunctionData("lockNative", [hashlock, qToHex(recipient), timeout]);
};

/** ERC-20 escrow lock: the amount rides in calldata (msg.value must be 0)
 *  and the HTLC pulls the tokens via transferFrom, so the exact-amount
 *  allowance must already be in place. */
export const buildLockTokenData = (
  hashlock: string,
  recipient: string,
  token: string,
  amount: bigint,
  timeout: number,
): string => {
  assertEthersAddressRecipient(recipient);
  return htlcInterface.encodeFunctionData("lockToken", [
    hashlock,
    qToHex(recipient),
    token,
    amount,
    timeout,
  ]);
};

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

export const buildClaimData = (leg: LegKey, hashlock: string, preimage: string): string => {
  assertLegCalldataReady(leg);
  if (leg === "qrl") return encodeQrvmHtlc("claim", [hashlock, preimage]);
  return htlcInterface.encodeFunctionData("claim", [hashlock, preimage]);
};

export const buildRefundData = (leg: LegKey, hashlock: string): string => {
  assertLegCalldataReady(leg);
  if (leg === "qrl") return encodeQrvmHtlc("refund", [hashlock]);
  return htlcInterface.encodeFunctionData("refund", [hashlock]);
};

/** Open-recipient (prelock) escrow: no recipient in the calldata; it is
 *  fixed later by assign(). */
export const buildLockNativeOpenData = (
  leg: LegKey,
  hashlock: string,
  timeout: number,
): string => {
  assertLegCalldataReady(leg);
  if (leg === "qrl") return encodeQrvmHtlc("lockNativeOpen", [hashlock, timeout]);
  return htlcInterface.encodeFunctionData("lockNativeOpen", [hashlock, timeout]);
};

export const buildLockTokenOpenData = (
  hashlock: string,
  token: string,
  amount: bigint,
  timeout: number,
): string => htlcInterface.encodeFunctionData("lockTokenOpen", [hashlock, token, amount, timeout]);

/** One-time, initiator-only recipient assignment on an open lock. */
export const buildAssignData = (leg: LegKey, hashlock: string, recipient: string): string => {
  assertLegCalldataReady(leg);
  if (leg === "qrl") return encodeQrvmHtlc("assign", [hashlock, recipient]);
  assertEthersAddressRecipient(recipient);
  return htlcInterface.encodeFunctionData("assign", [hashlock, qToHex(recipient)]);
};

/** On-demand escrow reclaim, valid only while the lock is unassigned. */
export const buildReleaseData = (leg: LegKey, hashlock: string): string => {
  assertLegCalldataReady(leg);
  if (leg === "qrl") return encodeQrvmHtlc("release", [hashlock]);
  return htlcInterface.encodeFunctionData("release", [hashlock]);
};

/** Move the caller's whole credit in `token` to `to`. Only the credited
 *  account can call this, and it chooses the destination. */
export const buildWithdrawAllData = (leg: LegKey, token: string, to: string): string => {
  assertLegCalldataReady(leg);
  if (leg === "qrl") return encodeQrvmHtlc("withdrawAll", [token, to]);
  assertEthersAddressRecipient(to);
  return htlcInterface.encodeFunctionData("withdrawAll", [token, qToHex(to)]);
};

/** Move part of the caller's credit in `token` to `to`. */
export const buildWithdrawData = (
  leg: LegKey,
  token: string,
  to: string,
  amount: bigint,
): string => {
  assertLegCalldataReady(leg);
  if (leg === "qrl") return encodeQrvmHtlc("withdraw", [token, to, amount]);
  assertEthersAddressRecipient(to);
  return htlcInterface.encodeFunctionData("withdraw", [token, qToHex(to), amount]);
};

/** Deliver `account`'s whole credit in `token` to `account`. Permissionless
 *  and with no destination parameter, so it can only ever pay the address
 *  the fund owner chose: a payee with no gas on this chain can be paid by
 *  anyone without handing anyone redirect authority. */
export const buildPushCreditData = (leg: LegKey, token: string, account: string): string => {
  assertLegCalldataReady(leg);
  if (leg === "qrl") return encodeQrvmHtlc("pushCredit", [token, account]);
  assertEthersAddressRecipient(account);
  return htlcInterface.encodeFunctionData("pushCredit", [token, qToHex(account)]);
};

export const shortAddr = (addr: string): string =>
  addr.startsWith("Q")
    ? formatQrlAddressFingerprint(addr)
    : addr.length > 12
      ? `${addr.slice(0, 8)}…${addr.slice(-4)}`
      : addr;
