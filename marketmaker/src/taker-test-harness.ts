// Offline harness for the scripted taker: an in-memory HTLC chain behind
// a real JSON-RPC HTTP endpoint, a real HTTP order book speaking the
// subset of the wire protocol a taker uses, and a scripted maker signing
// genuine ML-DSA-87 proofs. Test-only; nothing here ships in the daemon.

import { createHash, randomBytes } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { Interface, id as keccakId } from "ethers";
import type { AssetSymbol } from "./assets.js";
import type { LegSender, SendOptions } from "./chains.js";
import {
  ERC20_ABI,
  HTLC_ABI,
  QRL_NATIVE_TOKEN,
  NATIVE_TOKEN,
  SwapStatus,
  qToHex,
  type LegKey,
} from "./htlc.js";
import type { Direction, SelectedFillIntentV1 } from "./policy.js";
import { protocolV2Config } from "./protocol-v2-config.js";
import {
  ProtocolSigner,
  computeFillIntentDigest,
  computeFillDigest,
  computeOrderDigest,
  deriveOrderV1Id,
  type SignedFillIntentV1,
  type SignedFillV1,
  type SignedOrderV1,
} from "./protocol-signing.js";

const htlcInterface = new Interface(HTLC_ABI);
const erc20Interface = new Interface(ERC20_ABI);

export const sha256Hex = (hex: string): string =>
  `0x${createHash("sha256").update(Buffer.from(hex.slice(2), "hex")).digest("hex")}`;

export interface FakeSwap {
  initiator: string;
  recipient: string;
  token: string;
  amount: bigint;
  timeout: number;
  status: number;
  preimage: string;
}

const ZERO32 = `0x${"0".repeat(64)}`;

function emptySwap(leg: LegKey): FakeSwap {
  const zero = leg === "qrl" ? QRL_NATIVE_TOKEN : NATIVE_TOKEN;
  return {
    initiator: zero,
    recipient: zero,
    token: zero,
    amount: 0n,
    timeout: 0,
    status: SwapStatus.None,
    preimage: ZERO32,
  };
}

/** HTLCv3, from contracts/hyperion/HTLCv3.hyp. */
export const DELIVERY_GAS_LIMIT = 100_000n;
export const DELIVERY_GAS_RESERVE = 150_000n;

const creditKey = (token: string, account: string): string =>
  `${qToHex(token).toLowerCase()}:${qToHex(account).toLowerCase()}`;

/** An HTLC deployment with block history, so reads at confirmation depth
 *  mean what they mean on a real chain. Models HTLCv3: a settlement whose
 *  delivery fails stays terminal and leaves the amount as a credit owned by
 *  the payee. */
export class FakeHtlcChain {
  private readonly swaps = new Map<string, FakeSwap>();
  private readonly history: Map<string, FakeSwap>[] = [];
  /** Token balances, only used by the ERC-20 leg. */
  readonly balances = new Map<string, bigint>();
  readonly allowances = new Map<string, bigint>();
  /** Payees whose delivery fails: a nonpayable recipient contract, or an
   *  issuer blocklist on that address. Settlements to them credit. Keyed on
   *  the hexadecimal form, so a Q address and its QRVM word are one entry. */
  private readonly rejected = new Set<string>();

  rejectDeliveryTo(account: string): void {
    this.rejected.add(qToHex(account).toLowerCase());
  }

  allowDeliveryTo(account: string): void {
    this.rejected.delete(qToHex(account).toLowerCase());
  }

  private deliveryFails(account: string): boolean {
    return this.rejected.has(qToHex(account).toLowerCase());
  }
  /** token => account => undelivered payout owned by that account. */
  private readonly credits = new Map<string, bigint>();
  private readonly outstanding = new Map<string, bigint>();
  /** PayoutCredited, which is the only record that names which swap left a
   *  credit behind: the ledger above is keyed only by token and account. */
  private readonly creditedLogs: {
    token: string;
    account: string;
    hashlock: string;
    amount: bigint;
  }[] = [];
  /**
   * When set, a settlement credits unless the sender supplied the published
   * gas buffer. That is what the real contract does: the payout attempt runs
   * in a child frame with a bounded budget, so a caller that sends a bare
   * estimate defers every time. A client that drops the buffer fails here.
   */
  deferWithoutGasBuffer = false;
  /** Set by the sender for the duration of one apply. */
  suppliedGasBuffer = false;

  /** Test-only: a balance on the same ledger entry from a different swap,
   *  with no PayoutCredited log for the swap under test. */
  addForeignCredit(token: string, account: string, amount: bigint): void {
    this.credits.set(creditKey(token, account), this.creditOf(token, account) + amount);
    const tokenKey = qToHex(token).toLowerCase();
    this.outstanding.set(tokenKey, this.outstandingCredit(token) + amount);
  }

  creditOf(token: string, account: string): bigint {
    return this.credits.get(creditKey(token, account)) ?? 0n;
  }

  outstandingCredit(token: string): bigint {
    return this.outstanding.get(qToHex(token).toLowerCase()) ?? 0n;
  }

  /** The payout half of a settlement: deliver, or credit the payee. Exactly
   *  one of the two happens, so value is conserved either way. */
  private settle(token: string, payee: string, amount: bigint, hashlock: string): void {
    const tokenKey = qToHex(token).toLowerCase();
    if (this.deliveryFails(payee) || (this.deferWithoutGasBuffer && !this.suppliedGasBuffer)) {
      this.creditedLogs.push({ token, account: payee, hashlock, amount });
      this.credits.set(creditKey(token, payee), this.creditOf(token, payee) + amount);
      this.outstanding.set(tokenKey, this.outstandingCredit(token) + amount);
      return;
    }
    if (tokenKey !== qToHex(NATIVE_TOKEN).toLowerCase() && tokenKey !== qToHex(QRL_NATIVE_TOKEN).toLowerCase()) {
      const holder = qToHex(payee).toLowerCase();
      this.balances.set(holder, (this.balances.get(holder) ?? 0n) + amount);
    }
  }

  /** withdraw/withdrawAll: only the credited account moves its own credit,
   *  and it names the destination. */
  moveCredit(from: string, token: string, to: string, amount?: bigint): void {
    // The contract's order: InvalidParams on the destination, then NoCredit,
    // then InsufficientCredit. A test that relies on a different order would
    // pass here and fail on chain.
    const zeroAddress = this.leg === "qrl" ? QRL_NATIVE_TOKEN : NATIVE_TOKEN;
    if (
      qToHex(to).toLowerCase() === qToHex(zeroAddress).toLowerCase() ||
      qToHex(to).toLowerCase() === qToHex(this.htlc).toLowerCase()
    ) {
      throw new Error("InvalidParams");
    }
    const held = this.creditOf(token, from);
    const moved = amount ?? held;
    if (moved <= 0n) throw new Error("NoCredit");
    if (held < moved) throw new Error("InsufficientCredit");
    // Strict: a failed transfer reverts the whole withdrawal and leaves the
    // credit intact, because a reverted withdrawal loses nothing.
    if (this.deliveryFails(to)) throw new Error("TransferFailed");
    this.credits.set(creditKey(token, from), held - moved);
    const tokenKey = qToHex(token).toLowerCase();
    this.outstanding.set(tokenKey, this.outstandingCredit(token) - moved);
    const destination = qToHex(to).toLowerCase();
    if (tokenKey !== qToHex(NATIVE_TOKEN).toLowerCase() && tokenKey !== qToHex(QRL_NATIVE_TOKEN).toLowerCase()) {
      this.balances.set(destination, (this.balances.get(destination) ?? 0n) + moved);
    }
  }

  /** pushCredit: permissionless and destinationless, so the only address it
   *  can pay is the credited account itself. */
  pushCredit(token: string, account: string): void {
    const held = this.creditOf(token, account);
    if (held <= 0n) throw new Error("NoCredit");
    this.moveCredit(account, token, account, held);
  }

  constructor(
    readonly leg: LegKey,
    readonly htlc: string,
    private readonly clock: () => number,
  ) {
    this.snapshot();
  }

  get height(): number {
    return this.history.length - 1;
  }

  /** Commit the current state as a new block. */
  snapshot(): void {
    this.history.push(new Map([...this.swaps].map(([k, v]) => [k, { ...v }])));
  }

  at(blockTag: string): Map<string, FakeSwap> {
    if (blockTag === "latest") {
      return this.history[this.history.length - 1] ?? new Map();
    }
    const height = Number(BigInt(blockTag));
    return this.history[Math.min(Math.max(height, 0), this.height)] ?? new Map();
  }

  getSwap(hashlock: string, blockTag: string): FakeSwap {
    return this.at(blockTag).get(hashlock.toLowerCase()) ?? emptySwap(this.leg);
  }

  lock(args: {
    from: string;
    hashlock: string;
    recipient: string;
    token?: string;
    amount: bigint;
    timeout: number;
  }): void {
    const key = args.hashlock.toLowerCase();
    if (this.swaps.has(key)) throw new Error("HashlockUsed");
    this.swaps.set(key, {
      initiator: args.from,
      recipient: args.recipient,
      token: args.token ?? (this.leg === "qrl" ? QRL_NATIVE_TOKEN : NATIVE_TOKEN),
      amount: args.amount,
      timeout: args.timeout,
      status: SwapStatus.Open,
      preimage: ZERO32,
    });
    this.snapshot();
  }

  claim(hashlock: string, preimage: string): void {
    const key = hashlock.toLowerCase();
    const swap = this.swaps.get(key);
    if (swap === undefined || swap.status !== SwapStatus.Open) {
      throw new Error("NotOpen");
    }
    if (sha256Hex(preimage) !== key) throw new Error("BadPreimage");
    if (this.clock() >= swap.timeout) throw new Error("TimeoutPassed");
    // HTLCv3: the terminal state and the preimage are written first and
    // unconditionally, then delivery is attempted. Nothing the payout does
    // can roll this back.
    this.swaps.set(key, { ...swap, status: SwapStatus.Claimed, preimage });
    this.settle(swap.token, swap.recipient, swap.amount, key);
    this.snapshot();
  }

  /** Would this claim succeed right now? Used by the preflight path. */
  canClaim(hashlock: string, preimage: string): boolean {
    const swap = this.swaps.get(hashlock.toLowerCase());
    return (
      swap !== undefined &&
      swap.status === SwapStatus.Open &&
      sha256Hex(preimage) === hashlock.toLowerCase() &&
      this.clock() < swap.timeout
    );
  }

  /** Test-only: rewrite a stored record, for RPC responses a hostile or
   *  confused endpoint could return. */
  overwrite(hashlock: string, swap: FakeSwap): void {
    this.swaps.set(hashlock.toLowerCase(), { ...swap });
    this.snapshot();
  }

  refund(from: string, hashlock: string): void {
    const key = hashlock.toLowerCase();
    const swap = this.swaps.get(key);
    if (swap === undefined || swap.status !== SwapStatus.Open) {
      throw new Error("NotOpen");
    }
    if (qToHex(swap.initiator).toLowerCase() !== qToHex(from).toLowerCase()) {
      throw new Error("NotInitiator");
    }
    if (this.clock() < swap.timeout) throw new Error("TimeoutPending");
    this.swaps.set(key, { ...swap, status: SwapStatus.Refunded });
    this.settle(swap.token, swap.initiator, swap.amount, key);
    this.snapshot();
  }

  /** Initiator-only reclaim of an unassigned open lock. Emits Refunded, and
   *  its payout defers exactly like every other settlement. */
  release(from: string, hashlock: string): void {
    const key = hashlock.toLowerCase();
    const swap = this.swaps.get(key);
    if (swap === undefined || swap.status !== SwapStatus.Open) throw new Error("NotOpen");
    if (qToHex(swap.initiator).toLowerCase() !== qToHex(from).toLowerCase()) {
      throw new Error("NotInitiator");
    }
    const zero = this.leg === "qrl" ? QRL_NATIVE_TOKEN : NATIVE_TOKEN;
    if (qToHex(swap.recipient).toLowerCase() !== qToHex(zero).toLowerCase()) {
      throw new Error("AlreadyAssigned");
    }
    this.swaps.set(key, { ...swap, status: SwapStatus.Refunded });
    this.settle(swap.token, swap.initiator, swap.amount, key);
    this.snapshot();
  }

  /** PayoutCredited entries matching a pinned topic filter, in the shape an
   *  RPC returns them. The filter is compared as topic strings, so the fake
   *  agrees with the client only when both build them the same way. */
  creditedLogsByTopic(
    token?: string,
    account?: string,
    hashlock?: string,
  ): { data: string; topics: string[] }[] {
    const word = (value: bigint): string =>
      this.leg === "qrl"
        ? value.toString(16).padStart(128, "0")
        : value.toString(16).padStart(64, "0");
    const hashTopic = (value: string): string =>
      this.leg === "qrl" ? `${value.toLowerCase()}${"0".repeat(64)}` : value.toLowerCase();
    return this.creditedLogs
      .map((entry) => ({
        data: `0x${word(entry.amount)}`,
        topics: [
          payoutCreditedTopicFor(this.leg),
          addressTopicFor(this.leg, entry.token),
          addressTopicFor(this.leg, entry.account),
          hashTopic(entry.hashlock),
        ],
      }))
      .filter(
        (log) =>
          (token === undefined || log.topics[1] === token.toLowerCase()) &&
          (account === undefined || log.topics[2] === account.toLowerCase()) &&
          (hashlock === undefined || log.topics[3] === hashlock.toLowerCase()),
      );
  }
}

/** Topic forms the clients build, mirrored so the fake compares like for like. */
export function payoutCreditedTopicFor(leg: LegKey): string {
  const frag = htlcInterface.getEvent("PayoutCredited");
  if (frag === null) throw new Error("unknown event");
  return leg === "qrl" ? `${frag.topicHash}${"0".repeat(64)}` : frag.topicHash;
}

function addressTopicFor(leg: LegKey, address: string): string {
  const hex = qToHex(address).slice(2).toLowerCase();
  return leg === "qrl" ? `0x${hex.padStart(128, "0")}` : `0x${hex.padStart(64, "0")}`;
}

const qrvmWordFromAddress = (value: string): string =>
  qToHex(value).slice(2).toLowerCase().padStart(128, "0");

const qrvmWordFromUint = (value: bigint): string =>
  value.toString(16).padStart(128, "0");

/** One or more 64-byte QRVM return words holding uint256 values. */
function qrvmUintResult(values: readonly bigint[]): string {
  return `0x${values.map(qrvmWordFromUint).join("")}`;
}

function encodeQrvmSwapResult(swap: FakeSwap): string {
  return (
    "0x" +
    qrvmWordFromAddress(swap.initiator) +
    qrvmWordFromAddress(swap.recipient) +
    qrvmWordFromAddress(swap.token) +
    qrvmWordFromUint(swap.amount) +
    qrvmWordFromUint(BigInt(swap.timeout)) +
    qrvmWordFromUint(BigInt(swap.status)) +
    swap.preimage.slice(2).padEnd(128, "0")
  );
}

function encodeEthSwapResult(swap: FakeSwap): string {
  return htlcInterface.encodeFunctionResult("getSwap", [
    [
      swap.initiator,
      swap.recipient,
      swap.token,
      swap.amount,
      BigInt(swap.timeout),
      BigInt(swap.status),
      swap.preimage,
    ],
  ]);
}

export interface FakeEndpoint {
  url: string;
  close(): Promise<void>;
  /** Stop holding the event loop open, so a test can prove that only the
   *  code under test keeps the process alive. */
  unref(): void;
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks).toString("utf8");
  return body === "" ? {} : (JSON.parse(body) as unknown);
}

/** A JSON-RPC endpoint over a FakeHtlcChain, serving exactly the methods
 *  the taker reads: chain id, genesis, head, and eth_call / qrl_call. */
export async function startFakeChainRpc(
  chain: FakeHtlcChain,
): Promise<FakeEndpoint> {
  const ns = chain.leg;
  const server = createServer((req, res) => {
    void (async () => {
      const request = (await readJson(req)) as {
        id?: unknown;
        method?: string;
        params?: unknown[];
      };
      const reply = (result: unknown): void => {
        const body = JSON.stringify({ jsonrpc: "2.0", id: request.id ?? 1, result });
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        });
        res.end(body);
      };
      const fail = (message: string): void => {
        const body = JSON.stringify({
          jsonrpc: "2.0",
          id: request.id ?? 1,
          error: { code: -32000, message },
        });
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        });
        res.end(body);
      };
      const method = request.method ?? "";
      if (method === `${ns}_chainId`) {
        const id =
          ns === "eth" ? protocolV2Config.ethChainId : protocolV2Config.qrlChainId;
        reply(`0x${BigInt(id).toString(16)}`);
        return;
      }
      if (method === "qrl_getBlockByNumber") {
        reply({ hash: protocolV2Config.qrlGenesisHash });
        return;
      }
      if (method === `${ns}_blockNumber`) {
        reply(`0x${chain.height.toString(16)}`);
        return;
      }
      if (method === `${ns}_getLogs`) {
        const filter = (request.params?.[0] ?? {}) as { topics?: unknown };
        const topics = Array.isArray(filter.topics) ? filter.topics : [];
        const wanted = (index: number): string | undefined =>
          typeof topics[index] === "string" ? (topics[index] as string) : undefined;
        // Only PayoutCredited is served, which is the only log the clients
        // query by hashlock.
        if (wanted(0) !== payoutCreditedTopicFor(chain.leg)) {
          reply([]);
          return;
        }
        reply(chain.creditedLogsByTopic(wanted(1), wanted(2), wanted(3)));
        return;
      }
      if (method === `${ns}_call`) {
        const call = (request.params?.[0] ?? {}) as { to?: string; data?: string };
        const blockTag = (request.params?.[1] as string) ?? "latest";
        const data = call.data ?? "";
        try {
          reply(callFakeChain(chain, data, blockTag));
        } catch (error) {
          fail(error instanceof Error ? error.message : "reverted");
        }
        return;
      }
      fail(`unsupported method ${method}`);
    })().catch(() => {
      res.writeHead(500).end();
    });
  });
  const url = await listen(server);
  return {
    url,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
    unref: () => {
      server.unref();
    },
  };
}

function callFakeChain(
  chain: FakeHtlcChain,
  data: string,
  blockTag: string,
): string {
  if (chain.leg === "qrl") {
    const selector = data.slice(0, 10);
    const words = data.slice(10);
    const word = (index: number): string =>
      words.slice(index * 128, (index + 1) * 128);
    if (selector === selectorOf("getSwap(bytes32)")) {
      const hashlock = `0x${word(0).slice(0, 64)}`;
      return encodeQrvmSwapResult(chain.getSwap(hashlock, blockTag));
    }
    if (selector === selectorOf("claim(bytes32,bytes32)")) {
      const hashlock = `0x${word(0).slice(0, 64)}`;
      const preimage = `0x${word(1).slice(0, 64)}`;
      if (!chain.canClaim(hashlock, preimage)) throw new Error("reverted");
      return "0x";
    }
    if (selector === selectorOf("creditOf(address,address)")) {
      return qrvmUintResult([chain.creditOf(`0x${word(0)}`, `0x${word(1)}`)]);
    }
    if (selector === selectorOf("outstandingCredit(address)")) {
      return qrvmUintResult([chain.outstandingCredit(`0x${word(0)}`)]);
    }
    if (selector === selectorOf("deliveryGasPolicy()")) {
      return qrvmUintResult([DELIVERY_GAS_LIMIT, DELIVERY_GAS_RESERVE]);
    }
    throw new Error("unsupported QRVM call");
  }
  const parsed = safeParse(data);
  if (parsed === null) throw new Error("unsupported call");
  if (parsed.name === "getSwap") {
    return encodeEthSwapResult(
      chain.getSwap(parsed.args[0] as string, blockTag),
    );
  }
  if (parsed.name === "claim") {
    if (!chain.canClaim(parsed.args[0] as string, parsed.args[1] as string)) {
      throw new Error("reverted");
    }
    return "0x";
  }
  if (parsed.name === "creditOf") {
    return htlcInterface.encodeFunctionResult("creditOf", [
      chain.creditOf(parsed.args[0] as string, parsed.args[1] as string),
    ]);
  }
  if (parsed.name === "outstandingCredit") {
    return htlcInterface.encodeFunctionResult("outstandingCredit", [
      chain.outstandingCredit(parsed.args[0] as string),
    ]);
  }
  if (parsed.name === "deliveryGasPolicy") {
    return htlcInterface.encodeFunctionResult("deliveryGasPolicy", [
      DELIVERY_GAS_LIMIT,
      DELIVERY_GAS_RESERVE,
    ]);
  }
  if (parsed.name === "allowance") {
    const key = `${String(parsed.args[0]).toLowerCase()}:${String(parsed.args[1]).toLowerCase()}`;
    return erc20Interface.encodeFunctionResult("allowance", [
      chain.allowances.get(key) ?? 0n,
    ]);
  }
  if (parsed.name === "balanceOf") {
    return erc20Interface.encodeFunctionResult("balanceOf", [
      chain.balances.get(String(parsed.args[0]).toLowerCase()) ?? 0n,
    ]);
  }
  throw new Error("unsupported call");
}

function safeParse(
  data: string,
): { name: string; args: readonly unknown[] } | null {
  for (const iface of [htlcInterface, erc20Interface]) {
    try {
      const parsed = iface.parseTransaction({ data });
      if (parsed !== null) return { name: parsed.name, args: parsed.args };
    } catch {
      // try the next ABI
    }
  }
  return null;
}

/** Keccak-256 selector, matching the QRVM codec in qrvmHtlc.ts. */
function selectorOf(signature: string): string {
  return keccakId(signature).slice(0, 10);
}

/** A LegSender that applies calldata straight to a FakeHtlcChain, so a
 *  test exercises the engine without a node or a real signer. */
export class FakeLegSender implements LegSender {
  readonly sent: { data: string; value: bigint; to?: string; settlement?: boolean }[] = [];
  private nativeBalance: bigint;

  constructor(
    readonly address: string,
    private readonly chain: FakeHtlcChain,
    nativeBalance = 10n ** 20n,
  ) {
    this.nativeBalance = nativeBalance;
  }

  async balance(): Promise<bigint> {
    return this.nativeBalance;
  }

  async send(
    data: string,
    valueWei: bigint,
    to?: string,
    options: SendOptions = {},
  ): Promise<string> {
    this.sent.push({
      data,
      value: valueWei,
      ...(to === undefined ? {} : { to }),
      ...(options.settlement === true ? { settlement: true } : {}),
    });
    // The real contract decides delivery from the gas the caller supplied, so
    // the fake is told whether the published buffer rode along.
    this.chain.suppliedGasBuffer = options.settlement === true;
    try {
      if (this.chain.leg === "qrl") {
        this.applyQrvm(data, valueWei);
      } else {
        this.applyEth(data, valueWei, to);
      }
    } finally {
      this.chain.suppliedGasBuffer = false;
    }
    this.nativeBalance -= valueWei;
    return `0x${randomBytes(32).toString("hex")}`;
  }

  private applyQrvm(data: string, valueWei: bigint): void {
    const selector = data.slice(0, 10);
    const words = data.slice(10);
    const word = (index: number): string =>
      words.slice(index * 128, (index + 1) * 128);
    if (selector === selectorOf("lockNative(bytes32,address,uint256)")) {
      this.chain.lock({
        from: this.address,
        hashlock: `0x${word(0).slice(0, 64)}`,
        recipient: `0x${word(1)}`,
        amount: valueWei,
        timeout: Number(BigInt(`0x${word(2)}`)),
      });
      return;
    }
    if (selector === selectorOf("claim(bytes32,bytes32)")) {
      this.chain.claim(`0x${word(0).slice(0, 64)}`, `0x${word(1).slice(0, 64)}`);
      return;
    }
    if (selector === selectorOf("refund(bytes32)")) {
      this.chain.refund(this.address, `0x${word(0).slice(0, 64)}`);
      return;
    }
    if (selector === selectorOf("release(bytes32)")) {
      this.chain.release(this.address, `0x${word(0).slice(0, 64)}`);
      return;
    }
    if (selector === selectorOf("withdrawAll(address,address)")) {
      this.chain.moveCredit(this.address, `0x${word(0)}`, `0x${word(1)}`);
      return;
    }
    if (selector === selectorOf("pushCredit(address,address)")) {
      this.chain.pushCredit(`0x${word(0)}`, `0x${word(1)}`);
      return;
    }
    throw new Error("unsupported QRVM transaction");
  }

  private applyEth(data: string, valueWei: bigint, to?: string): void {
    const parsed = safeParse(data);
    if (parsed === null) throw new Error("unsupported transaction");
    if (parsed.name === "approve" && to !== undefined) {
      this.chain.allowances.set(
        `${this.address.toLowerCase()}:${String(parsed.args[0]).toLowerCase()}`,
        parsed.args[1] as bigint,
      );
      return;
    }
    if (parsed.name === "lockNative") {
      this.chain.lock({
        from: this.address,
        hashlock: parsed.args[0] as string,
        recipient: parsed.args[1] as string,
        amount: valueWei,
        timeout: Number(parsed.args[2] as bigint),
      });
      return;
    }
    if (parsed.name === "lockToken") {
      // The HTLC pulls the tokens, so an escrow without an allowance and a
      // balance reverts here exactly as it would on chain.
      const amount = parsed.args[3] as bigint;
      const owner = this.address.toLowerCase();
      const key = `${owner}:${this.chain.htlc.toLowerCase()}`;
      const allowance = this.chain.allowances.get(key) ?? 0n;
      if (allowance < amount) throw new Error("ERC20InsufficientAllowance");
      const balance = this.chain.balances.get(owner) ?? 0n;
      if (balance < amount) throw new Error("ERC20InsufficientBalance");
      this.chain.allowances.set(key, allowance - amount);
      this.chain.balances.set(owner, balance - amount);
      this.chain.lock({
        from: this.address,
        hashlock: parsed.args[0] as string,
        recipient: parsed.args[1] as string,
        token: parsed.args[2] as string,
        amount,
        timeout: Number(parsed.args[4] as bigint),
      });
      return;
    }
    if (parsed.name === "claim") {
      this.chain.claim(parsed.args[0] as string, parsed.args[1] as string);
      return;
    }
    if (parsed.name === "refund") {
      this.chain.refund(this.address, parsed.args[0] as string);
      return;
    }
    if (parsed.name === "release") {
      this.chain.release(this.address, parsed.args[0] as string);
      return;
    }
    if (parsed.name === "withdrawAll") {
      this.chain.moveCredit(
        this.address,
        parsed.args[0] as string,
        parsed.args[1] as string,
      );
      return;
    }
    if (parsed.name === "withdraw") {
      this.chain.moveCredit(
        this.address,
        parsed.args[0] as string,
        parsed.args[1] as string,
        parsed.args[2] as bigint,
      );
      return;
    }
    if (parsed.name === "pushCredit") {
      this.chain.pushCredit(parsed.args[0] as string, parsed.args[1] as string);
      return;
    }
    throw new Error("unsupported transaction");
  }
}

interface BookRecord {
  order: SignedOrderV1;
  id: string;
  orderDigest: string;
  status: "open" | "locking" | "cancelled";
  intents: SelectedFillIntentV1[];
  released: Set<string>;
  releasedFlag: boolean;
  fill: SignedFillV1 | null;
  fillDigest: string | null;
  selected: SelectedFillIntentV1 | null;
  createdAt: number;
  updatedAt: number;
}

/** The subset of the order book wire protocol a taker speaks, served over
 *  real HTTP so the client's transport checks run for real. */
export class FakeBookServer {
  private readonly orders = new Map<string, BookRecord>();
  private server: Server | null = null;
  url = "";
  /** Force one response shape for a negative test. */
  mutateRow: ((row: Record<string, unknown>) => Record<string, unknown>) | null =
    null;
  /** Reject the next intent submission with 409. */
  conflictOnIntent = false;

  constructor(private readonly clock: () => number) {}

  async start(): Promise<void> {
    const server = createServer((req, res) => {
      void this.handle(req, res).catch(() => {
        res.writeHead(500).end();
      });
    });
    this.server = server;
    this.url = `${await listen(server)}/api`;
  }

  /** See FakeEndpoint.unref. */
  unref(): void {
    this.server?.unref();
  }

  async close(): Promise<void> {
    const server = this.server;
    if (server === null) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  list(orderId: string): SelectedFillIntentV1[] {
    return this.orders.get(orderId)?.intents ?? [];
  }

  publish(order: SignedOrderV1): string {
    const id = deriveOrderV1Id(order.order.makerQrlAccount, order.auth.nonce);
    this.orders.set(id, {
      order,
      id,
      orderDigest: computeOrderDigest(order.order, order.auth),
      status: "open",
      intents: [],
      released: new Set(),
      releasedFlag: false,
      fill: null,
      fillDigest: null,
      selected: null,
      createdAt: this.clock(),
      updatedAt: this.clock(),
    });
    return id;
  }

  cancel(orderId: string): void {
    const record = this.orders.get(orderId);
    if (record !== undefined) record.status = "cancelled";
  }

  drop(orderId: string): void {
    this.orders.delete(orderId);
  }

  applyFill(orderId: string, fill: SignedFillV1, selected: SelectedFillIntentV1): void {
    const record = this.orders.get(orderId);
    if (record === undefined) throw new Error("unknown order");
    record.fill = fill;
    record.selected = selected;
    record.fillDigest = computeFillDigest(fill.fill, record.order.auth, fill.auth);
    record.status = "locking";
    record.updatedAt = this.clock();
  }

  markReleased(orderId: string): void {
    const record = this.orders.get(orderId);
    if (record !== undefined) record.releasedFlag = true;
  }

  private row(record: BookRecord): Record<string, unknown> {
    const order = record.order.order;
    const row: Record<string, unknown> = {
      id: record.id,
      direction: order.direction,
      asset: order.asset,
      fromAmount: order.fromAmount,
      toAmount: order.toAmount,
      makerEthAccount: order.makerEthAccount,
      makerQrlAccount: order.makerQrlAccount,
      status: record.status,
      takerEthAccount: record.fill?.fill.takerEthAccount ?? null,
      takerQrlAccount: record.fill?.fill.takerQrlAccount ?? null,
      hashlock: record.fill?.fill.hashlock ?? order.prelock?.hashlock ?? null,
      initiatorTimeout:
        record.fill?.fill.initiatorTimeout ?? order.prelock?.initiatorTimeout ?? null,
      responderTimeout: record.fill?.fill.responderTimeout ?? null,
      released: record.releasedFlag,
      makerSeen: true,
      visibility: order.visibility,
      prelocked: order.prelock !== undefined,
      makerAuth: record.order.auth,
      orderDigest: record.orderDigest,
      equivocated: false,
      conflictDigests: [],
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
    if (record.fill !== null && record.selected !== null) {
      row["fill"] = record.fill.fill;
      row["fillAuth"] = record.fill.auth;
      row["fillDigest"] = record.fillDigest;
      row["selectedIntent"] = record.selected;
    }
    return this.mutateRow === null ? row : this.mutateRow(row);
  }

  private async handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", "http://book.invalid");
    const path = url.pathname.replace(/^\/api/, "");
    const send = (status: number, body: unknown): void => {
      const text = JSON.stringify(body);
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(text),
      });
      res.end(text);
    };
    if (req.method === "GET" && path === "/orders") {
      send(200, {
        orders: [...this.orders.values()]
          .filter((record) => record.status === "open")
          .map((record) => this.row(record)),
      });
      return;
    }
    const idMatch = /^\/orders\/([0-9a-f]{64})(?:\/(intents|fill|release))?$/.exec(
      path,
    );
    if (idMatch === null) {
      send(404, { error: "unknown route" });
      return;
    }
    const record = this.orders.get(idMatch[1] ?? "");
    if (record === undefined) {
      send(404, { error: "order not found" });
      return;
    }
    const action = idMatch[2];
    if (req.method === "GET" && action === undefined) {
      send(200, { order: this.row(record) });
      return;
    }
    if (req.method === "POST" && action === "intents") {
      if (this.conflictOnIntent) {
        send(409, { error: "a pending proposal already exists" });
        return;
      }
      const body = (await readJson(req)) as SignedFillIntentV1;
      const intentDigest = computeFillIntentDigest(body.intent, body.auth);
      const pending = record.intents.find(
        (entry) =>
          entry.intent.takerQrlAccount === body.intent.takerQrlAccount &&
          entry.auth.expiresAt > this.clock() &&
          !record.released.has(entry.intentDigest),
      );
      if (pending !== undefined && pending.intentDigest !== intentDigest) {
        send(409, { error: "this account already has a pending proposal" });
        return;
      }
      const stored: SelectedFillIntentV1 = {
        intentDigest,
        intent: body.intent,
        auth: body.auth,
        receivedAt: this.clock(),
      };
      if (pending === undefined) record.intents.push(stored);
      send(201, { intent: stored });
      return;
    }
    if (req.method === "POST" && action === "release") {
      const body = (await readJson(req)) as {
        releaseSecret?: string;
        intentDigest?: string;
        fillDigest?: string;
      };
      if (body.intentDigest !== undefined) record.released.add(body.intentDigest);
      record.releasedFlag = true;
      send(200, { order: this.row(record) });
      return;
    }
    send(404, { error: "unknown route" });
  }
}

export interface ScriptedMakerOptions {
  direction: Direction;
  asset: AssetSymbol;
  fromAmount: string;
  toAmount: string;
  makerEthAccount: string;
  initiatorWindowS?: number;
  responderWindowS?: number;
  responseWindowS?: number;
}

/** A maker that signs real proofs and drives the fake chains, so the taker
 *  under test faces the same protocol a live maker produces. */
export class ScriptedMaker {
  readonly signer: ProtocolSigner;
  order: SignedOrderV1 | null = null;
  orderId = "";
  fill: SignedFillV1 | null = null;
  readonly preimage: string;
  readonly hashlock: string;

  constructor(
    seed: string,
    private readonly book: FakeBookServer,
    private readonly options: ScriptedMakerOptions,
    private readonly clock: () => number,
    preimage = `0x${randomBytes(32).toString("hex")}`,
  ) {
    this.signer = new ProtocolSigner(seed);
    this.preimage = preimage;
    this.hashlock = sha256Hex(preimage);
  }

  get qrlAccount(): string {
    return this.signer.address;
  }

  publishOrder(lifetimeS = 3600): string {
    const issuedAt = this.clock();
    const order = this.signer.signOrderV1(
      {
        direction: this.options.direction,
        asset: this.options.asset,
        fromAmount: this.options.fromAmount,
        toAmount: this.options.toAmount,
        makerEthAccount: this.options.makerEthAccount,
        makerQrlAccount: this.signer.address,
      },
      {
        makerToken: randomBytes(32).toString("hex"),
        issuedAt,
        expiresAt: issuedAt + lifetimeS,
      },
    );
    this.order = order;
    this.orderId = this.book.publish(order);
    return this.orderId;
  }

  /** Select the first proposal and publish the terminal FillV2. */
  selectAndFill(): SignedFillV1 {
    const order = this.order;
    if (order === null) throw new Error("no order published");
    const selected = this.book.list(this.orderId)[0];
    if (selected === undefined) throw new Error("no proposal to select");
    const issuedAt = this.clock();
    const fill = this.signer.signFillV1(
      {
        orderDigest: computeOrderDigest(order.order, order.auth),
        intentDigest: selected.intentDigest,
        takerEthAccount: selected.intent.takerEthAccount,
        takerQrlAccount: selected.intent.takerQrlAccount,
        releaseCommitment: selected.intent.releaseCommitment,
        hashlock: this.hashlock,
        initiatorTimeout: issuedAt + (this.options.initiatorWindowS ?? 7200),
        responderTimeout: issuedAt + (this.options.responderWindowS ?? 3600),
      },
      {
        order,
        selectedIntent: {
          intentDigest: selected.intentDigest,
          intent: selected.intent,
          auth: selected.auth,
        },
        issuedAt,
        respondBy: issuedAt + (this.options.responseWindowS ?? 300),
      },
    );
    this.fill = fill;
    this.book.applyFill(this.orderId, fill, selected);
    return fill;
  }

  close(): void {
    this.signer.close();
  }
}
