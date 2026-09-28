// The QRL leg's fee inputs, checked on the transaction it actually signs.
// A local JSON-RPC server plays the node; it captures the raw transaction
// at broadcast and refuses it, so the test needs no receipt flow.

import { strict as assert } from "node:assert";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";
import { MLDSA87 } from "@theqrl/wallet.js";
import { MAX_QRL_TIP_WEI, QrlLeg, suggestedQrlTip } from "./chains.js";
import { protocolV2Config } from "./protocol-v2-config.js";
import { canonicalQip55QrlAddress } from "./qip55.js";

const BASE_FEE = 7n;
const GWEI = 1_000_000_000n;

let tipAnswer: { result?: unknown; error?: { code: number; message: string } };
let methods: string[] = [];
let rawTx: string | undefined;
let server: Server;
let url: string;

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function answer(method: string, params: unknown[]): {
  result?: unknown;
  error?: { code: number; message: string };
} {
  switch (method) {
    case "qrl_chainId":
      return { result: `0x${BigInt(protocolV2Config.qrlChainId).toString(16)}` };
    case "net_version":
      return { result: protocolV2Config.qrlChainId };
    case "qrl_getBlockByNumber":
      return params[0] === "0x0"
        ? { result: { hash: protocolV2Config.qrlGenesisHash } }
        : {
            result: {
              number: "0x10",
              baseFeePerGas: `0x${BASE_FEE.toString(16)}`,
              gasLimit: "0x1c9c380",
            },
          };
    case "qrl_maxPriorityFeePerGas":
      return tipAnswer;
    case "qrl_getTransactionCount":
      return { result: "0x3" };
    case "qrl_estimateGas":
      return { result: "0x186a0" };
    case "qrl_blockNumber":
      return { result: "0x10" };
    case "qrl_call":
      return { result: "0x" };
    case "qrl_gasPrice":
      return { result: "0x9502f907" };
    case "qrl_sendRawTransaction":
      rawTx = String(params[0]);
      return { error: { code: -32000, message: "captured by test" } };
    default:
      return { error: { code: -32601, message: `unexpected ${method}` } };
  }
}

/** Read the head of a type-2 envelope:
 *  0x02 || rlp([chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gas, ...]). */
function decodeType2Head(raw: string): {
  maxPriorityFeePerGas: bigint;
  maxFeePerGas: bigint;
  gas: bigint;
} {
  const buf = Buffer.from(raw.replace(/^0x/, ""), "hex");
  assert.equal(buf[0], 0x02, "type-2 transaction");
  let at = 1;
  const listPrefix = buf[at]!;
  at += listPrefix > 0xf7 ? 1 + (listPrefix - 0xf7) : 1;
  const items: bigint[] = [];
  while (items.length < 5) {
    const prefix = buf[at]!;
    if (prefix <= 0x7f) {
      items.push(BigInt(prefix));
      at += 1;
    } else if (prefix <= 0xb7) {
      const len = prefix - 0x80;
      const bytes = buf.subarray(at + 1, at + 1 + len);
      items.push(len === 0 ? 0n : BigInt(`0x${bytes.toString("hex")}`));
      at += 1 + len;
    } else {
      throw new Error("unexpected long scalar in transaction head");
    }
  }
  return { maxPriorityFeePerGas: items[2]!, maxFeePerGas: items[3]!, gas: items[4]! };
}

function newLeg(): QrlLeg {
  const signer = MLDSA87.newWallet();
  const htlc = MLDSA87.newWallet();
  try {
    return new QrlLeg({
      qrlRpcUrl: url,
      qrlHexseed: signer.getHexExtendedSeed(),
      qrlHtlc: canonicalQip55QrlAddress(htlc.getAddressStr()),
      qrlChainId: protocolV2Config.qrlChainId,
      netTimeoutMs: 5_000,
      txTimeoutMs: 5_000,
    });
  } finally {
    (signer as typeof signer & { zeroize(): void }).zeroize();
    (htlc as typeof htlc & { zeroize(): void }).zeroize();
  }
}

async function signedFees(): Promise<ReturnType<typeof decodeType2Head>> {
  await assert.rejects(newLeg().send("0x", 0n, undefined, { settlement: false }), /captured by test/);
  assert.ok(rawTx, "the leg broadcast a signed transaction");
  return decodeType2Head(rawTx);
}

describe("QrlLeg fee inputs", () => {
  before(async () => {
    server = createServer((req, res) => {
      void readBody(req).then((body) => {
        const { id, method, params } = JSON.parse(body) as {
          id: unknown;
          method: string;
          params: unknown[];
        };
        methods.push(method);
        const reply = JSON.stringify({ jsonrpc: "2.0", id, ...answer(method, params ?? []) });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(reply);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  beforeEach(() => {
    tipAnswer = { result: "0x9502f900" }; // 2.5 gwei
    methods = [];
    rawTx = undefined;
  });

  it("tips the node's suggestion with 2x base-fee headroom", async () => {
    tipAnswer = { result: `0x${(4n * GWEI).toString(16)}` };
    const fees = await signedFees();
    assert.equal(fees.maxPriorityFeePerGas, 4n * GWEI);
    assert.equal(fees.maxFeePerGas, 2n * BASE_FEE + 4n * GWEI);
    assert.equal(fees.gas, 130_000n, "the 1.3x buffered estimate");
    assert.ok(!methods.includes("qrl_gasPrice"), "no dead gasPrice read");
  });

  it("caps a hostile suggestion at MAX_QRL_TIP_WEI", async () => {
    tipAnswer = { result: `0x${(10_000n * GWEI).toString(16)}` };
    const fees = await signedFees();
    assert.equal(fees.maxPriorityFeePerGas, MAX_QRL_TIP_WEI);
    assert.equal(fees.maxFeePerGas, 2n * BASE_FEE + MAX_QRL_TIP_WEI);
  });

  it("falls back to the library default tip on a node without the method", async () => {
    tipAnswer = { error: { code: -32601, message: "the method does not exist" } };
    const fees = await signedFees();
    assert.equal(fees.maxPriorityFeePerGas, 2_500_000_000n, "@theqrl/web3 default");
    assert.equal(fees.maxFeePerGas, 2n * BASE_FEE + 2_500_000_000n);
  });
});

describe("suggestedQrlTip", () => {
  it("passes a suggestion through and caps it", async () => {
    assert.equal(await suggestedQrlTip(() => Promise.resolve(3n * GWEI)), 3n * GWEI);
    assert.equal(await suggestedQrlTip(() => Promise.resolve("0x9502f900")), 2_500_000_000n);
    assert.equal(await suggestedQrlTip(() => Promise.resolve(MAX_QRL_TIP_WEI + 1n)), MAX_QRL_TIP_WEI);
  });

  it("returns undefined for a failed read or an unusable answer", async () => {
    assert.equal(await suggestedQrlTip(() => Promise.reject(new Error("timeout"))), undefined);
    assert.equal(await suggestedQrlTip(() => Promise.resolve("not a number")), undefined);
    assert.equal(await suggestedQrlTip(() => Promise.resolve(-1n)), undefined);
    assert.equal(await suggestedQrlTip(() => Promise.resolve({})), undefined);
  });
});
