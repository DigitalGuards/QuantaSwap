// Transaction senders for both legs. ETH via ethers, QRL via @theqrl/web3
// (local ML-DSA-87 signing from the hexseed, the nft-deploy pattern).

import { JsonRpcProvider, Wallet } from "ethers";
import * as qrlweb3 from "@theqrl/web3";
import type { Config } from "./config.js";

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

  constructor(cfg: Config) {
    this.provider = new JsonRpcProvider(cfg.ethRpcUrl);
    this.wallet = new Wallet(cfg.ethPrivateKey, this.provider);
    this.address = this.wallet.address;
    this.htlc = cfg.ethHtlc;
  }

  async balance(): Promise<bigint> {
    return this.provider.getBalance(this.address);
  }

  async send(data: string, valueWei: bigint): Promise<string> {
    const tx = await this.wallet.sendTransaction({ to: this.htlc, data, value: valueWei });
    await tx.wait();
    return tx.hash;
  }
}

export class QrlLeg {
  readonly address: string;
  private readonly web3: Qrlweb3;
  private readonly htlc: string;

  constructor(cfg: Config) {
    this.web3 = new Web3(new Web3.providers.HttpProvider(cfg.qrlRpcUrl));
    const account = this.web3.qrl.accounts.seedToAccount(cfg.qrlHexseed);
    this.address = account.address;
    this.web3.qrl.wallet?.add(cfg.qrlHexseed);
    this.web3.qrl.transactionConfirmationBlocks = 1;
    this.htlc = cfg.qrlHtlc;
  }

  async balance(): Promise<bigint> {
    return BigInt(await this.web3.qrl.getBalance(this.address));
  }

  async send(data: string, valueWei: bigint): Promise<string> {
    const base: Record<string, unknown> = {
      from: this.address,
      to: this.htlc,
      data,
      ...(valueWei > 0n ? { value: valueWei } : {}),
    };
    const gasPrice = await this.web3.qrl.getGasPrice();
    const estimated = await this.web3.qrl.estimateGas(base);
    const gas = (BigInt(estimated) * 13n) / 10n;
    const receipt = await this.web3.qrl.sendTransaction({ ...base, gas, gasPrice });
    return txHashHex(receipt.transactionHash);
  }
}
