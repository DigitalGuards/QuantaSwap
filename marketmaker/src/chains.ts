// Transaction senders for both legs. ETH via ethers, QRL via @theqrl/web3
// (local ML-DSA-87 signing from the hexseed, the nft-deploy pattern).

import { FetchRequest, JsonRpcProvider, Wallet } from "ethers";
import * as qrlweb3 from "@theqrl/web3";
import type { Config } from "./config.js";

/** Bound any promise so a hung library call cannot wedge the single-
 *  threaded tick. Used for @theqrl/web3, which takes no abort signal; the
 *  ethers leg uses native FetchRequest.timeout + wait() deadlines instead.
 *  The underlying socket may linger, but the tick is freed. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    timer.unref();
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

interface Web3Ctor {
  new (provider: unknown): Qrlweb3;
  providers: { HttpProvider: new (url: string) => unknown };
}

// CJS/ESM interop: depending on the loader the class sits on the
// namespace or on its default export.
const ns = qrlweb3 as unknown as { Web3?: Web3Ctor; default?: { Web3?: Web3Ctor } };
const resolvedWeb3 = ns.Web3 ?? ns.default?.Web3;
if (!resolvedWeb3) throw new Error("@theqrl/web3 did not expose Web3");
const Web3: Web3Ctor = resolvedWeb3;

interface QrlAccount {
  address: string;
}

interface Qrlweb3 {
  qrl: {
    accounts: { seedToAccount(seed: string): QrlAccount };
    wallet?: { add(seed: string): void };
    transactionConfirmationBlocks: number;
    getBalance(addr: string): Promise<bigint>;
    getGasPrice(): Promise<bigint>;
    estimateGas(tx: Record<string, unknown>): Promise<bigint>;
    sendTransaction(tx: Record<string, unknown>): Promise<{ transactionHash: unknown }>;
  };
}

const txHashHex = (h: unknown): string =>
  typeof h === "string" ? h : `0x${Buffer.from(h as Uint8Array).toString("hex")}`;

export class EthLeg {
  readonly address: string;
  private readonly wallet: Wallet;
  private readonly provider: JsonRpcProvider;
  private readonly htlc: string;
  private readonly txTimeoutMs: number;

  constructor(cfg: Config) {
    // FetchRequest.timeout bounds every RPC request (submit, balance, etc.);
    // the ethers default is 5 minutes, far too long for the serial tick.
    const req = new FetchRequest(cfg.ethRpcUrl);
    req.timeout = cfg.netTimeoutMs;
    this.provider = new JsonRpcProvider(req);
    this.wallet = new Wallet(cfg.ethPrivateKey, this.provider);
    this.address = this.wallet.address;
    this.htlc = cfg.ethHtlc;
    this.txTimeoutMs = cfg.txTimeoutMs;
  }

  async balance(): Promise<bigint> {
    return this.provider.getBalance(this.address);
  }

  async send(data: string, valueWei: bigint): Promise<string> {
    const tx = await this.wallet.sendTransaction({ to: this.htlc, data, value: valueWei });
    // Bound the confirmation wait: a stuck tx throws instead of hanging the
    // tick forever, and decide() reconciles from chain state next tick.
    await tx.wait(1, this.txTimeoutMs);
    return tx.hash;
  }
}

export class QrlLeg {
  readonly address: string;
  private readonly web3: Qrlweb3;
  private readonly htlc: string;
  private readonly netTimeoutMs: number;
  private readonly txTimeoutMs: number;

  constructor(cfg: Config) {
    this.web3 = new Web3(new Web3.providers.HttpProvider(cfg.qrlRpcUrl));
    const account = this.web3.qrl.accounts.seedToAccount(cfg.qrlHexseed);
    this.address = account.address;
    this.web3.qrl.wallet?.add(cfg.qrlHexseed);
    this.web3.qrl.transactionConfirmationBlocks = 1;
    this.htlc = cfg.qrlHtlc;
    this.netTimeoutMs = cfg.netTimeoutMs;
    this.txTimeoutMs = cfg.txTimeoutMs;
  }

  async balance(): Promise<bigint> {
    return BigInt(await withTimeout(this.web3.qrl.getBalance(this.address), this.netTimeoutMs, "qrl getBalance"));
  }

  async send(data: string, valueWei: bigint): Promise<string> {
    const base: Record<string, unknown> = {
      from: this.address,
      to: this.htlc,
      data,
      ...(valueWei > 0n ? { value: valueWei } : {}),
    };
    const gasPrice = await withTimeout(this.web3.qrl.getGasPrice(), this.netTimeoutMs, "qrl getGasPrice");
    const estimated = await withTimeout(this.web3.qrl.estimateGas(base), this.netTimeoutMs, "qrl estimateGas");
    const gas = (BigInt(estimated) * 13n) / 10n;
    const receipt = await withTimeout(
      this.web3.qrl.sendTransaction({ ...base, gas, gasPrice }),
      this.txTimeoutMs,
      "qrl sendTransaction",
    );
    return txHashHex(receipt.transactionHash);
  }
}
