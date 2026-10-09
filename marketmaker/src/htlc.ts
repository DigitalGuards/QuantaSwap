import { isRecord, isArray } from "./guards.js";
// HTLC reads and calldata for both legs over plain JSON-RPC, mirroring
// frontend/src/lib/htlc.ts. Chain state is the only trusted input: the
// order book coordinates, the chain decides.

import { Interface } from "ethers";
import { decodeQrvmSwap, decodeQrvmUints, encodeQrvmHtlc } from "./qrvmHtlc.js";
import { protocolV2Config } from "./protocol-v2-config.js";
import {
  QIP55_QRVM_ABI_ERROR,
  QRVM_ZERO_ADDRESS,
  assertQip55ReadReady,
  isQip55QrlAddress,
  qrlOrEthHex,
} from "./qip55.js";

export const HTLC_ABI = [
  "function lockNative(bytes32 hashlock, address recipient, uint256 timeout) payable",
  "function lockToken(bytes32 hashlock, address recipient, address token, uint256 amount, uint256 timeout)",
  "function claim(bytes32 hashlock, bytes32 preimage)",
  "function refund(bytes32 hashlock)",
  "function getSwap(bytes32 hashlock) view returns (tuple(address initiator, address recipient, address token, uint256 amount, uint256 timeout, uint8 status, bytes32 preimage))",
  // HTLCv3 payout credits. A settlement whose delivery fails stays
  // terminal and leaves the amount as a credit owned by the payee: the
  // payee redirects it with withdraw/withdrawAll, and anyone can deliver
  // it to the payee itself with the destinationless pushCredit.
  "function withdraw(address token, address to, uint256 amount)",
  "function withdrawAll(address token, address to)",
  "function pushCredit(address token, address account)",
  "function creditOf(address token, address account) view returns (uint256)",
  "function outstandingCredit(address token) view returns (uint256)",
  "function deliveryGasPolicy() view returns (uint256 gasLimit, uint256 gasReserve)",
  "event PayoutCredited(address indexed token, address indexed account, bytes32 indexed hashlock, uint256 amount)",
  "event PayoutWithdrawn(address indexed token, address indexed account, address to, uint256 amount)",
];

/** The HTLCv3 delivery budget and credit reserve, mirrored from
 *  contracts/hyperion/HTLCv3.hyp and published on chain by
 *  deliveryGasPolicy(). */
export const DELIVERY_GAS_LIMIT = 100_000n;
export const DELIVERY_GAS_RESERVE = 150_000n;

/** The settlement gas rule of docs/audit/HTLCV3_SCOPE.md (A1, A2): submit
 *  claim, refund and release with `estimateGas + DELIVERY_GAS_LIMIT +
 *  DELIVERY_GAS_RESERVE`. Estimation minimises gas and the credit path is
 *  cheaper than a real transfer, so a bare estimate defers a payout that
 *  would have gone through. It matters most for a sponsored claim, where a
 *  taker with no gas on the paying chain cannot withdraw a credit. Unused
 *  gas is refunded, so the buffer costs only transaction-limit headroom. */
export const SETTLEMENT_GAS_BUFFER = DELIVERY_GAS_LIMIT + DELIVERY_GAS_RESERVE;

export const settlementGasLimit = (estimate: bigint): bigint =>
  estimate + SETTLEMENT_GAS_BUFFER;

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

export const SwapStatus = {
  None: 0,
  Open: 1,
  Claimed: 2,
  Refunded: 3,
} as const;
export type SwapStatusValue = (typeof SwapStatus)[keyof typeof SwapStatus];

/** Ethereum address(0). QRL QRVM64 uses QRL_NATIVE_TOKEN. */
export const NATIVE_TOKEN = `0x${"0".repeat(40)}`;
export const QRL_NATIVE_TOKEN = QRVM_ZERO_ADDRESS;

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

function isSwapStatus(value: number): value is SwapStatusValue {
  return value === 0 || value === 1 || value === 2 || value === 3;
}

function rpcBytes(raw: unknown): string {
  if (typeof raw !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(raw)) {
    throw new TypeError("RPC returned malformed ABI bytes");
  }
  return raw;
}

type EvmSwapTuple = [string, string, string, bigint, bigint, bigint, string];

function isEvmSwapTuple(value: unknown): value is EvmSwapTuple {
  return (
    isArray(value) &&
    value.length === 7 &&
    typeof value[0] === "string" &&
    typeof value[1] === "string" &&
    typeof value[2] === "string" &&
    typeof value[3] === "bigint" &&
    typeof value[4] === "bigint" &&
    typeof value[5] === "bigint" &&
    typeof value[6] === "string"
  );
}

function decodeEvmUint(abi: Interface, method: string, raw: unknown): bigint {
  const decoded: unknown = abi.decodeFunctionResult(method, rpcBytes(raw));
  if (
    !isArray(decoded) ||
    decoded.length !== 1 ||
    typeof decoded[0] !== "bigint"
  ) {
    throw new TypeError("Malformed EVM uint result");
  }
  return decoded[0];
}

export const qToHex = (addr: string): string => qrlOrEthHex(addr);

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
  const body: unknown = await res.json();
  if (!isRecord(body))
    throw new TypeError(`RPC ${method} returned a malformed response`);
  if (body.error !== undefined && body.error !== null) {
    if (!isRecord(body.error))
      throw new TypeError(`RPC ${method} returned a malformed error`);
    throw new Error(
      typeof body.error.message === "string"
        ? body.error.message
        : `RPC ${method} error`,
    );
  }
  if (!Object.hasOwn(body, "result"))
    throw new TypeError(`RPC ${method} omitted its result`);
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

export async function getChainId(leg: LegRpc): Promise<string> {
  const result = await rpc(leg.url, `${leg.ns}_chainId`, [], leg.timeoutMs);
  if (typeof result !== "string" || result.length === 0) {
    throw new Error(`${leg.ns} RPC returned a malformed chain ID`);
  }
  return result;
}

export async function assertQrlRuntime(leg: LegRpc): Promise<void> {
  if (leg.ns !== "qrl") return;
  assertQip55ReadReady(leg.htlc);
  const [chain, block] = await Promise.all([
    getChainId(leg),
    rpc(leg.url, "qrl_getBlockByNumber", ["0x0", false], leg.timeoutMs),
  ]);
  if (
    BigInt(chain) !== BigInt(protocolV2Config.qrlChainId) ||
    !isRecord(block) ||
    !("hash" in block) ||
    block.hash !== protocolV2Config.qrlGenesisHash
  )
    throw new Error(
      "QRL RPC chain or genesis mismatch; refusing v3 operations",
    );
}

/** Simulate exact HTLC calldata from the real transaction sender against
 * latest state. Claim callers must treat any RPC or EVM error as fatal and
 * must not broadcast the secret-bearing calldata. The deliberately generic
 * error prevents a hostile RPC response from reflecting the preimage into
 * daemon logs. */
export async function simulateHtlcCall(
  leg: LegRpc,
  from: string,
  data: string,
  valueWei = 0n,
): Promise<void> {
  await assertQrlRuntime(leg);
  try {
    const result = await rpc(
      leg.url,
      `${leg.ns}_call`,
      [
        {
          from,
          to: leg.htlc,
          data,
          value: `0x${valueWei.toString(16)}`,
        },
        "latest",
      ],
      leg.timeoutMs,
    );
    if (typeof result !== "string" || !/^0x[0-9a-fA-F]*$/.test(result)) {
      throw new Error("malformed result");
    }
  } catch {
    throw new Error(
      `${leg.ns} HTLC preflight rejected; claim was not broadcast`,
    );
  }
}

/**
 * The hard claim cutoff of docs/FINALITY.md section 3.3, re-checked at
 * broadcast. `claim` closes at the escrow's own timeout, so a claim that is
 * composed in good time and mines at or after it reverts with the preimage
 * already public and the swap still Open. A margin checked when a decision
 * was taken is not a margin at broadcast, so the escrow's timeout is read
 * again from chain immediately before the secret goes out, and a claim
 * inside the margin is abandoned.
 */
export interface ClaimCutoff {
  hashlock: string;
  marginS: number;
  nowS: () => number;
}

export const claimCutoffBlocked = (
  timeout: number,
  nowS: number,
  marginS: number,
): boolean => nowS >= timeout - marginS;

/** Choke point for claim submission. The callback may persist the attempt
 * marker and broadcast only after preflight succeeds. It is never invoked
 * on a failed simulation, and its errors are sanitized before logging.
 * `cutoff` fails the submission closed when the escrow's own deadline moved
 * inside the safety margin since the decision was taken. */
export async function submitPreflightedClaim(
  leg: LegRpc,
  from: string,
  data: string,
  submit: () => Promise<string>,
  cutoff?: ClaimCutoff,
): Promise<string> {
  await simulateHtlcCall(leg, from, data, 0n);
  if (cutoff !== undefined) {
    // A read failure fails the claim closed: an unknown deadline is not a safe
    // one, and the next tick retries. The read is sanitized like the preflight
    // above, because a hostile or misconfigured RPC can put its URL or the
    // request body into an error, and this runs on the secret-bearing path.
    let blocked: boolean;
    try {
      const state = await getSwapState(leg, cutoff.hashlock);
      blocked =
        state.status === SwapStatus.Open &&
        claimCutoffBlocked(state.timeout, cutoff.nowS(), cutoff.marginS);
    } catch {
      throw new Error(
        `${leg.ns} claim deadline could not be re-read; the secret was not broadcast`,
      );
    }
    if (blocked) {
      throw new Error(
        `${leg.ns} claim abandoned inside the escrow's safety margin; the secret was not broadcast`,
      );
    }
  }
  try {
    return await submit();
  } catch {
    // Provider errors can reflect transaction calldata. Never pass a
    // secret-bearing RPC error through the daemon logger.
    throw new Error(
      `${leg.ns} claim submission failed; reconcile chain state before retry`,
    );
  }
}

export async function getBlockNumber(leg: LegRpc): Promise<number> {
  const raw = await rpc(leg.url, `${leg.ns}_blockNumber`, [], leg.timeoutMs);
  if (typeof raw !== "string" || !/^0x[0-9a-fA-F]+$/.test(raw)) {
    throw new TypeError("RPC returned a malformed block number");
  }
  const height = Number(BigInt(raw));
  if (!Number.isSafeInteger(height))
    throw new TypeError("RPC returned an unsafe block number");
  return height;
}

export async function getSwapState(
  leg: LegRpc,
  hashlock: string,
  blockTag = "latest",
): Promise<LegState> {
  await assertQrlRuntime(leg);
  const data =
    leg.ns === "qrl"
      ? encodeQrvmHtlc("getSwap", [hashlock])
      : iface.encodeFunctionData("getSwap", [hashlock]);
  const raw = await rpc(
    leg.url,
    `${leg.ns}_call`,
    [{ to: leg.htlc, data }, blockTag],
    leg.timeoutMs,
  );
  if (leg.ns === "qrl") return decodeQrvmSwap(raw);
  const decoded: unknown = iface.decodeFunctionResult("getSwap", rpcBytes(raw));
  if (
    !isArray(decoded) ||
    decoded.length !== 1 ||
    !isEvmSwapTuple(decoded[0])
  ) {
    throw new TypeError("Malformed EVM swap result");
  }
  const [initiator, recipient, token, amount, timeout, status, preimage] =
    decoded[0];
  const numericStatus = Number(status);
  const numericTimeout = Number(timeout);
  if (!isSwapStatus(numericStatus) || !Number.isSafeInteger(numericTimeout)) {
    throw new TypeError("Malformed EVM swap status or timeout");
  }
  return {
    status: numericStatus,
    initiator,
    recipient,
    token,
    amount,
    timeout: numericTimeout,
    preimage,
  };
}

/** State `confirmations` blocks behind the head: the trust gate for
 *  irreversible responses, identical to the frontend's. */
export async function getConfirmedSwapState(
  leg: LegRpc,
  hashlock: string,
  confirmations: number,
): Promise<LegState> {
  if (leg.ns === "qrl") assertQip55ReadReady(leg.htlc);
  const head = await getBlockNumber(leg);
  const depth = Math.max(0, head - confirmations);
  return getSwapState(leg, hashlock, `0x${depth.toString(16)}`);
}

export const encodeLock = (
  leg: LegKey,
  hashlock: string,
  recipient: string,
  timeout: number,
): string => {
  if (leg === "qrl")
    return encodeQrvmHtlc("lockNative", [hashlock, recipient, timeout]);
  if (isQip55QrlAddress(recipient)) throw new Error(QIP55_QRVM_ABI_ERROR);
  return iface.encodeFunctionData("lockNative", [
    hashlock,
    qToHex(recipient),
    timeout,
  ]);
};

/** lockToken calldata: value rides in the calldata (msg.value 0) after an
 *  exact-amount approval. */
export const encodeLockToken = (
  hashlock: string,
  recipient: string,
  token: string,
  amount: bigint,
  timeout: number,
): string => {
  if (isQip55QrlAddress(recipient)) throw new Error(QIP55_QRVM_ABI_ERROR);
  return iface.encodeFunctionData("lockToken", [
    hashlock,
    qToHex(recipient),
    token,
    amount,
    timeout,
  ]);
};

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
  if (leg.ns !== "eth")
    throw new Error("ERC-20 allowances require the Ethereum leg");
  const data = erc20.encodeFunctionData("allowance", [owner, spender]);
  const raw = await rpc(
    leg.url,
    `${leg.ns}_call`,
    [{ to: token, data }, "latest"],
    leg.timeoutMs,
  );
  return decodeEvmUint(erc20, "allowance", raw);
}

export async function erc20BalanceOf(
  leg: LegRpc,
  token: string,
  holder: string,
): Promise<bigint> {
  if (leg.ns !== "eth")
    throw new Error("ERC-20 balances require the Ethereum leg");
  const data = erc20.encodeFunctionData("balanceOf", [holder]);
  const raw = await rpc(
    leg.url,
    `${leg.ns}_call`,
    [{ to: token, data }, "latest"],
    leg.timeoutMs,
  );
  return decodeEvmUint(erc20, "balanceOf", raw);
}

export const encodeClaim = (
  leg: LegKey,
  hashlock: string,
  preimage: string,
): string => {
  if (leg === "qrl") return encodeQrvmHtlc("claim", [hashlock, preimage]);
  return iface.encodeFunctionData("claim", [hashlock, preimage]);
};

export const encodeRefund = (leg: LegKey, hashlock: string): string => {
  if (leg === "qrl") return encodeQrvmHtlc("refund", [hashlock]);
  return iface.encodeFunctionData("refund", [hashlock]);
};

/** Move the caller's whole credit in `token` to `to`. */
export const encodeWithdrawAll = (
  leg: LegKey,
  token: string,
  to: string,
): string => {
  if (leg === "qrl") return encodeQrvmHtlc("withdrawAll", [token, to]);
  if (isQip55QrlAddress(to)) throw new Error(QIP55_QRVM_ABI_ERROR);
  return iface.encodeFunctionData("withdrawAll", [token, qToHex(to)]);
};

/** Deliver `account`'s whole credit in `token` to `account`. Permissionless
 *  and destinationless, so a sponsor can finish a deferred payout for a
 *  taker with no gas on that chain without gaining redirect authority. */
export const encodePushCredit = (
  leg: LegKey,
  token: string,
  account: string,
): string => {
  if (leg === "qrl") return encodeQrvmHtlc("pushCredit", [token, account]);
  if (isQip55QrlAddress(account)) throw new Error(QIP55_QRVM_ABI_ERROR);
  return iface.encodeFunctionData("pushCredit", [token, qToHex(account)]);
};

/** An indexed `address` topic word: 32 bytes left-padded on Ethereum, the
 *  64-byte address itself on QRVM-512. */
function addressTopic(ns: LegKey, address: string): string {
  const hex = qToHex(address).slice(2).toLowerCase();
  return ns === "qrl"
    ? `0x${hex.padStart(128, "0")}`
    : `0x${hex.padStart(64, "0")}`;
}

/** QRVM-512 log topics are 64-byte words: a 32-byte value sits in the high
 *  half followed by 32 zero bytes. Mirrors the browser's qrvm64Topic. */
const qrvm64Topic = (word: string): string =>
  `${word.toLowerCase()}${"0".repeat(64)}`;

const PAYOUT_CREDITED_TOPIC = (() => {
  const frag = iface.getEvent("PayoutCredited");
  if (frag === null) throw new Error("unknown HTLC event PayoutCredited");
  return frag.topicHash;
})();

/**
 * The amount `PayoutCredited` recorded for this exact swap, token and
 * account. `creditOf` is a ledger keyed only by (token, account), shared by
 * every swap that account ever settled, so it cannot say which swap left a
 * balance behind. The event can: its third indexed field is the hashlock.
 *
 * A maker needs this to avoid two failure modes at once: pinning an order
 * open for a credit another swap created, and giving another swap's credit to
 * this order's counterparty. All four topics are pinned, so the query stays
 * selective.
 */
export function creditFilterTopics(
  ns: LegKey,
  token: string,
  account: string,
  hashlock: string,
): [string, string, string, string] {
  return [
    ns === "qrl" ? qrvm64Topic(PAYOUT_CREDITED_TOPIC) : PAYOUT_CREDITED_TOPIC,
    addressTopic(ns, token),
    addressTopic(ns, account),
    ns === "qrl" ? qrvm64Topic(hashlock) : hashlock.toLowerCase(),
  ];
}

/** One PayoutCredited data word: 32 bytes on Ethereum, 64 on QRVM-512. Null
 *  for anything else, so a malformed answer is never read as a number. */
export function decodeCreditedAmount(ns: LegKey, data: unknown): bigint | null {
  const width = ns === "qrl" ? 128 : 64;
  if (
    typeof data !== "string" ||
    !new RegExp(`^0x[0-9a-fA-F]{${width}}$`).test(data)
  ) {
    return null;
  }
  return BigInt(data);
}

export async function getCreditedForSwap(
  leg: LegRpc,
  token: string,
  account: string,
  hashlock: string,
): Promise<bigint> {
  await assertQrlRuntime(leg);
  const raw = await rpc(
    leg.url,
    `${leg.ns}_getLogs`,
    [
      {
        address: leg.htlc,
        topics: creditFilterTopics(leg.ns, token, account, hashlock),
        fromBlock: "0x0",
        toBlock: "latest",
      },
    ],
    leg.timeoutMs,
  );
  if (!isArray(raw)) return 0n;
  let total = 0n;
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const { data } = entry;
    const amount = decodeCreditedAmount(leg.ns, data);
    if (amount === null) continue;
    total += amount;
  }
  return total;
}

/** What one payee still holds, and how much of it this swap left behind. */
export interface CreditReading {
  /** The per-(token, account) ledger balance, across every swap. */
  global: bigint;
  /** What this swap's settlement credited, from its PayoutCredited log. */
  credited: bigint;
}

/**
 * Read both halves. A withdrawal drains the shared ledger without naming a
 * swap, so what this swap can still be said to be owed is the smaller of the
 * two. The log query only runs when the ledger holds something, which keeps
 * it off the normal path entirely.
 */
export async function readSwapCredit(
  leg: LegRpc,
  token: string,
  account: string,
  hashlock: string,
): Promise<CreditReading> {
  const global = await getCredit(leg, token, account);
  const credited =
    global > 0n ? await getCreditedForSwap(leg, token, account, hashlock) : 0n;
  return { global, credited };
}

/** How deep a chain of wrapped causes is walked. Bounded so a self
 *  referential or absurdly nested error cannot spin here. */
const CAUSE_DEPTH = 6;

/** Every error in a wrapped chain, outermost first. @theqrl/web3 nests the
 *  real reason under `innerError`, ethers under `cause` or `info.error`. */
function causeChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  const seen = new Set<unknown>();
  let current = error;
  for (
    let depth = 0;
    depth < CAUSE_DEPTH && current !== undefined && current !== null;
    depth += 1
  ) {
    if (seen.has(current)) break;
    seen.add(current);
    chain.push(current);
    if (!isRecord(current)) break;
    const node = current;
    const next =
      node["innerError"] ??
      node["cause"] ??
      (isRecord(node["info"]) ? node["info"]["error"] : undefined);
    current = next;
  }
  return chain;
}

/** Error names and codes that mean "the contract refused this call". The
 *  @theqrl/web3 names come from @theqrl/web3-errors; ethers uses
 *  CALL_EXCEPTION for a revert. */
const REJECTION_NAMES = new Set([
  "ContractExecutionError",
  "Eip838ExecutionError",
  "TransactionRevertInstructionError",
  "TransactionRevertWithCustomError",
  "TransactionRevertedWithoutReasonError",
  "RevertInstructionError",
  "Web3ContractError",
]);
const REJECTION_CODES = new Set([
  "CALL_EXCEPTION",
  "ACTION_REJECTED",
  310, // ERR_CONTRACT_EXECUTION_REVERTED
  401, // ERR_TX_REVERT_INSTRUCTION
  402, // ERR_TX_REVERT_TRANSACTION
  405, // ERR_TX_REVERT_WITHOUT_REASON
  406, // ERR_TX_REVERT_TRANSACTION_CUSTOM_ERROR
  3, // EIP-1474 execution error
]);

const TRANSIENT_HINTS = [
  "timed out",
  "timeout",
  "econnrefused",
  "econnreset",
  "enotfound",
  "etimedout",
  "socket",
  "network",
  "fetch failed",
  "aborted",
  "http 5",
  "http 429",
  "nonce",
  "replacement",
  "underpriced",
  "rate limit",
  "connection not open",
];

const REJECTION_HINTS = [
  "revert",
  "transferfailed",
  "nocredit",
  "insufficientcredit",
  "invalidparams",
  "unauthorized",
  "status 0",
  "always failing transaction",
  "out of gas",
];

/**
 * Did the contract refuse this send, or did the attempt simply not get there?
 * The difference decides whether a credit is one step closer to being given up
 * on, so it has to be read from the error's shape and not only from its text.
 *
 * The text alone is not enough on the QRL leg: @theqrl/web3 wraps a revert in
 * a ContractExecutionError whose own message is the generic "Error happened
 * while trying to execute a function inside a smart contract", with the reason
 * under `innerError`. Reading only the outer message classified every QRL
 * revert as transient, so the cap never filled there and a taker whose address
 * cannot receive native QRL pinned an order forever.
 *
 * The transient shapes are checked first, over the whole wrapped chain, because
 * a timeout inside a contract call is still a timeout. Then the structure: a
 * known revert error class, a revert code, or present revert data. Then the
 * text, as a last resort for a provider that reports a revert as a plain
 * Error.
 *
 * An error that matches nothing is transient, which is the safe direction: the
 * cost is more retries, and the alternative is giving up on real money for a
 * reason nobody checked.
 */
export function isContractRejection(error: unknown): boolean {
  const chain = causeChain(error);
  const text = chain
    .map((node) => {
      if (node instanceof Error) return node.message;
      if (typeof node === "string") return node;
      if (isRecord(node)) {
        const message = node["message"];
        return typeof message === "string" ? message : "";
      }
      return "";
    })
    .join(" | ")
    .toLowerCase();

  if (TRANSIENT_HINTS.some((hint) => text.includes(hint))) return false;

  for (const node of chain) {
    if (!isRecord(node)) continue;
    const row = node;
    if (typeof row["name"] === "string" && REJECTION_NAMES.has(row["name"]))
      return true;
    const code = row["code"];
    if (
      (typeof code === "string" || typeof code === "number") &&
      REJECTION_CODES.has(code)
    ) {
      return true;
    }
    // Revert data is only ever produced by a call that reached the contract.
    const data = row["data"];
    if (
      typeof data === "string" &&
      /^0x[0-9a-fA-F]*$/.test(data) &&
      data.length > 2
    )
      return true;
    // A receipt with status 0 is a mined revert.
    const receipt = row["receipt"];
    if (isRecord(receipt)) {
      const status = receipt["status"];
      if (status === "0x0" || status === 0n || status === 0) return true;
    }
  }

  return REJECTION_HINTS.some((hint) => text.includes(hint));
}

/** Undelivered payout owned by `account` in `token` on this leg. Zero
 *  whenever the payout was delivered, which is the normal case. */
export async function getCredit(
  leg: LegRpc,
  token: string,
  account: string,
): Promise<bigint> {
  await assertQrlRuntime(leg);
  if (leg.ns === "qrl") {
    const raw = await rpc(
      leg.url,
      "qrl_call",
      [
        { to: leg.htlc, data: encodeQrvmHtlc("creditOf", [token, account]) },
        "latest",
      ],
      leg.timeoutMs,
    );
    return decodeQrvmUints(raw, 1)[0] ?? 0n;
  }
  const data = iface.encodeFunctionData("creditOf", [token, qToHex(account)]);
  const raw = await rpc(
    leg.url,
    "eth_call",
    [{ to: leg.htlc, data }, "latest"],
    leg.timeoutMs,
  );
  return decodeEvmUint(iface, "creditOf", raw);
}

export interface DeliveryGasPolicy {
  gasLimit: bigint;
  gasReserve: bigint;
}

/** The deployed contract's own delivery budget and credit reserve. Only
 *  HTLCv3 answers this call, so a successful read also proves the
 *  configured address is the interface this build settles against. */
export async function getDeliveryGasPolicy(
  leg: LegRpc,
): Promise<DeliveryGasPolicy> {
  await assertQrlRuntime(leg);
  if (leg.ns === "qrl") {
    const raw = await rpc(
      leg.url,
      "qrl_call",
      [
        { to: leg.htlc, data: encodeQrvmHtlc("deliveryGasPolicy", []) },
        "latest",
      ],
      leg.timeoutMs,
    );
    const [gasLimit, gasReserve] = decodeQrvmUints(raw, 2);
    return { gasLimit: gasLimit ?? 0n, gasReserve: gasReserve ?? 0n };
  }
  const data = iface.encodeFunctionData("deliveryGasPolicy", []);
  const raw = await rpc(
    leg.url,
    "eth_call",
    [{ to: leg.htlc, data }, "latest"],
    leg.timeoutMs,
  );
  const decoded: unknown = iface.decodeFunctionResult(
    "deliveryGasPolicy",
    rpcBytes(raw),
  );
  if (
    !isArray(decoded) ||
    decoded.length !== 2 ||
    typeof decoded[0] !== "bigint" ||
    typeof decoded[1] !== "bigint"
  ) {
    throw new TypeError("Malformed EVM delivery gas policy");
  }
  return { gasLimit: decoded[0], gasReserve: decoded[1] };
}

/** Refuse to run against a contract whose published budget differs from the
 *  one the settlement gas rule is built from. Called before the first send
 *  of a process, so a wrong address or a wrong contract generation stops the
 *  daemon at boot, before a single payout can quietly defer. */
export async function assertDeliveryGasPolicy(leg: LegRpc): Promise<void> {
  const policy = await getDeliveryGasPolicy(leg);
  if (
    policy.gasLimit !== DELIVERY_GAS_LIMIT ||
    policy.gasReserve !== DELIVERY_GAS_RESERVE
  ) {
    throw new Error(
      `the ${leg.ns} HTLC publishes a delivery budget this build was not written for (${policy.gasLimit}/${policy.gasReserve}); refusing to settle`,
    );
  }
}
