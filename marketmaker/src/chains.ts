// Transaction senders for both legs. ETH via ethers, QRL via @theqrl/web3
// (local ML-DSA-87 signing from the hexseed, the nft-deploy pattern).

import { FetchRequest, JsonRpcProvider, Wallet } from "ethers";
import { isRecord } from "./guards.js";
import { Web3, type Transaction } from "@theqrl/web3";
import type { Config } from "./config.js";
import { assertQip55ExecutionReady } from "./qip55.js";
import { assertQrlRuntime, settlementGasLimit, type LegRpc } from "./htlc.js";

/** Bound any promise so a hung library call cannot wedge the single-
 *  threaded tick. Used for @theqrl/web3, which takes no abort signal; the
 *  ethers leg uses native FetchRequest.timeout + wait() deadlines instead.
 *  The underlying socket may linger, but the tick is freed. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    timer.unref();
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** The slice of configuration a leg sender needs. Both the maker Config
 *  and the taker config satisfy it, so one sender serves both roles. */
export type EthLegConfig = Pick<
  Config,
  | "ethRpcUrl"
  | "ethPrivateKey"
  | "ethHtlc"
  | "ethChainId"
  | "netTimeoutMs"
  | "txTimeoutMs"
>;

export type QrlLegConfig = Pick<
  Config,
  | "qrlRpcUrl"
  | "qrlHexseed"
  | "qrlHtlc"
  | "qrlChainId"
  | "netTimeoutMs"
  | "txTimeoutMs"
>;

/** Per-send options. `settlement` applies the HTLCv3 gas rule
 *  (`estimateGas + 250000`) so a payout that can be delivered is not
 *  deferred into a credit by a minimal estimate; see
 *  docs/audit/HTLCV3_SCOPE.md A1 and A2. Every claim, refund, release and
 *  credit move sets it; locks and approvals do not. */
export interface SendOptions {
  settlement?: boolean;
}

/** Transaction sender surface shared by both legs, so callers and tests
 *  can depend on the capability, with the concrete client chosen by the
 *  caller. */
export interface LegSender {
  readonly address: string;
  balance(): Promise<bigint>;
  send(
    data: string,
    valueWei: bigint,
    to?: string,
    options?: SendOptions,
  ): Promise<string>;
}

/** Bounds on the QRL priority tip. The floor is @theqrl/web3's default
 *  tip, which every QRL send paid before the leg read the node, so a low
 *  suggestion never makes a claim slower than it was. The ceiling is 20x
 *  the devnet's 2.5 gwei suggestion: the daemon signs unattended, so an RPC
 *  answer can never set an unbounded tip. */
export const MIN_QRL_TIP_WEI = 2_500_000_000n;
export const MAX_QRL_TIP_WEI = 50_000_000_000n;

/** The priority tip for a QRL send: the node's suggestion
 *  (qrl_maxPriorityFeePerGas) clamped to [MIN_QRL_TIP_WEI,
 *  MAX_QRL_TIP_WEI], or the floor when the node does not answer. The
 *  library then signs a type-2 transaction with
 *  maxFeePerGas = 2 * baseFee + tip. A fallback or a cap is logged. */
export async function suggestedQrlTip(
  read: () => Promise<unknown>,
  warn: (message: string) => void = console.warn,
): Promise<bigint> {
  let tip: bigint;
  try {
    const answer = await read();
    if (
      typeof answer !== "bigint" &&
      typeof answer !== "string" &&
      typeof answer !== "number"
    ) {
      throw new Error("unusable answer");
    }
    tip = BigInt(answer);
  } catch (err) {
    warn(
      `qrl tip: node suggestion unavailable, using ${MIN_QRL_TIP_WEI} wei (${err instanceof Error ? err.message : "unknown error"})`,
    );
    return MIN_QRL_TIP_WEI;
  }
  if (tip > MAX_QRL_TIP_WEI) {
    warn(
      `qrl tip: node suggested ${tip} wei, capped at ${MAX_QRL_TIP_WEI} wei`,
    );
    return MAX_QRL_TIP_WEI;
  }
  return tip < MIN_QRL_TIP_WEI ? MIN_QRL_TIP_WEI : tip;
}

function qrlUint(value: unknown): bigint {
  if (
    typeof value !== "bigint" &&
    typeof value !== "string" &&
    typeof value !== "number"
  ) {
    throw new TypeError("QRL RPC returned a malformed quantity");
  }
  if (
    typeof value === "number" &&
    (!Number.isSafeInteger(value) || value < 0)
  ) {
    throw new TypeError("QRL RPC returned an unsafe quantity");
  }
  if (typeof value === "string" && !/^(?:[0-9]+|0x[0-9a-fA-F]+)$/.test(value)) {
    throw new TypeError("QRL RPC returned a malformed quantity");
  }
  const quantity = BigInt(value);
  if (quantity < 0n)
    throw new TypeError("QRL RPC returned a negative quantity");
  return quantity;
}

const txHashHex = (value: unknown): string => {
  if (typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value))
    return value;
  if (value instanceof Uint8Array && value.length === 32) {
    return `0x${Buffer.from(value).toString("hex")}`;
  }
  throw new TypeError("QRL transaction response has a malformed hash");
};

export class EthLeg implements LegSender {
  readonly address: string;
  private readonly wallet: Wallet;
  private readonly provider: JsonRpcProvider;
  private readonly htlc: string;
  private readonly txTimeoutMs: number;
  private readonly chainId: bigint;

  constructor(cfg: EthLegConfig) {
    // FetchRequest.timeout bounds every RPC request (submit, balance, etc.);
    // the ethers default is 5 minutes, far too long for the serial tick.
    const req = new FetchRequest(cfg.ethRpcUrl);
    req.timeout = cfg.netTimeoutMs;
    this.provider = new JsonRpcProvider(req);
    this.wallet = new Wallet(cfg.ethPrivateKey, this.provider);
    this.address = this.wallet.address;
    this.htlc = cfg.ethHtlc;
    this.txTimeoutMs = cfg.txTimeoutMs;
    this.chainId = BigInt(cfg.ethChainId);
  }

  async balance(): Promise<bigint> {
    return this.provider.getBalance(this.address);
  }

  /** Sends to the HTLC by default; ERC-20 approvals pass the token
   *  contract as `to`. Success is judged by the receipt status alone
   *  (wait() throws on a reverted tx), never by decoded return data, so
   *  no-return-value tokens (tUSDT) are safe. */
  async send(
    data: string,
    valueWei: bigint,
    to = this.htlc,
    options: SendOptions = {},
  ): Promise<string> {
    if ((await this.provider.getNetwork()).chainId !== this.chainId) {
      throw new Error("ETH RPC chain mismatch; refusing transaction");
    }
    // ethers estimates for us on an ordinary send. A settlement overrides
    // that estimate with the HTLCv3 rule.
    const gasLimit =
      options.settlement === true
        ? settlementGasLimit(
            await this.wallet.estimateGas({
              to,
              data,
              value: valueWei,
              chainId: this.chainId,
            }),
          )
        : undefined;
    const tx = await this.wallet.sendTransaction({
      to,
      data,
      value: valueWei,
      chainId: this.chainId,
      ...(gasLimit === undefined ? {} : { gasLimit }),
    });
    // Bound the confirmation wait: a stuck tx throws instead of hanging the
    // tick forever, and decide() reconciles from chain state next tick.
    await tx.wait(1, this.txTimeoutMs);
    return tx.hash;
  }
}

export class QrlLeg implements LegSender {
  readonly address: string;
  private readonly web3: Web3;
  private readonly htlc: string;
  private readonly netTimeoutMs: number;
  private readonly txTimeoutMs: number;
  private readonly chainId: bigint;
  private readonly rpc: LegRpc;

  constructor(cfg: QrlLegConfig) {
    this.web3 = new Web3(new Web3.providers.HttpProvider(cfg.qrlRpcUrl));
    const account = this.web3.qrl.accounts.seedToAccount(cfg.qrlHexseed);
    assertQip55ExecutionReady(account.address, cfg.qrlHtlc);
    this.address = account.address;
    this.web3.qrl.wallet?.add(cfg.qrlHexseed);
    this.web3.qrl.transactionConfirmationBlocks = 1;
    this.htlc = cfg.qrlHtlc;
    this.netTimeoutMs = cfg.netTimeoutMs;
    this.txTimeoutMs = cfg.txTimeoutMs;
    this.chainId = BigInt(cfg.qrlChainId);
    this.rpc = {
      ns: "qrl",
      url: cfg.qrlRpcUrl,
      htlc: cfg.qrlHtlc,
      timeoutMs: cfg.netTimeoutMs,
    };
  }

  async balance(): Promise<bigint> {
    await assertQrlRuntime(this.rpc);
    const balance: unknown = await withTimeout(
      this.web3.qrl.getBalance(this.address),
      this.netTimeoutMs,
      "qrl getBalance",
    );
    return qrlUint(balance);
  }

  async send(
    data: string,
    valueWei: bigint,
    _to?: string,
    options: SendOptions = {},
  ): Promise<string> {
    await assertQrlRuntime(this.rpc);
    const base: Transaction = {
      from: this.address,
      to: this.htlc,
      data,
      chainId: this.chainId,
      ...(valueWei > 0n ? { value: valueWei } : {}),
    };
    // @theqrl/web3 signs type-2 transactions only and has no gasPrice
    // field, so the tip is the one fee input that reaches the signature.
    const tip = await suggestedQrlTip(() =>
      withTimeout(
        this.web3.qrl.getMaxPriorityFeePerGas(),
        this.netTimeoutMs,
        "qrl maxPriorityFeePerGas",
      ),
    );
    const estimated: unknown = await withTimeout(
      this.web3.qrl.estimateGas(base),
      this.netTimeoutMs,
      "qrl estimateGas",
    );
    const gas =
      options.settlement === true
        ? settlementGasLimit(qrlUint(estimated))
        : (qrlUint(estimated) * 13n) / 10n;
    await assertQrlRuntime(this.rpc);
    const receipt: unknown = await withTimeout(
      this.web3.qrl.sendTransaction({
        ...base,
        gas,
        maxPriorityFeePerGas: tip,
      }),
      this.txTimeoutMs,
      "qrl sendTransaction",
    );
    if (!isRecord(receipt))
      throw new TypeError("QRL transaction response is malformed");
    return txHashHex(receipt.transactionHash);
  }
}
