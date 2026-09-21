import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { Web3 } from "@theqrl/web3";
import { encodeQrvmHtlc, decodeQrvmSwap } from "./qrvmHtlc.js";
import { assertQrlRuntime } from "./htlc.js";
import { protocolV2Config } from "./protocol-v2-config.js";

const web3 = new Web3();
const h = `0x${"ab".repeat(32)}`;
const a = `Q${"11".repeat(32)}${"c3".repeat(32)}`;
describe("market-maker QRVM codec", () => {
  it("matches the official 64-byte ABI for each native HTLC method", () => {
    const vectors = [
      ["lockNative", ["bytes32", "address", "uint256"], [h, a, "123"]],
      ["lockNativeOpen", ["bytes32", "uint256"], [h, "123"]],
      ["assign", ["bytes32", "address"], [h, a]],
      ["release", ["bytes32"], [h]],
      ["claim", ["bytes32", "bytes32"], [h, h]],
      ["refund", ["bytes32"], [h]],
      ["getSwap", ["bytes32"], [h]],
    ] as const;
    for (const [name, types, values] of vectors) {
      const official = web3.qrl.abi.encodeFunctionCall({
        name, type: "function", inputs: types.map((type, i) => ({ type, name: `v${i}` })),
      }, [...values]);
      assert.equal(encodeQrvmHtlc(name, values), official);
    }
  });
  it("keeps both address halves and rejects legacy identities", () => {
    const first = encodeQrvmHtlc("assign", [h, a]);
    const second = encodeQrvmHtlc("assign", [h, `Q${"22".repeat(32)}${"c3".repeat(32)}`]);
    assert.notEqual(first, second);
    assert.throws(() => encodeQrvmHtlc("assign", [h, `Q${"11".repeat(20)}`]));
    assert.throws(() => encodeQrvmHtlc("lockNativeOpen", [h, -1]));
    assert.throws(() => encodeQrvmHtlc("lockNativeOpen", [h, 1n << 256n]));
  });
  it("decodes the seven-word struct and refuses truncated or noncanonical data", () => {
    const raw = web3.qrl.abi.encodeParameters(
      ["address", "address", "address", "uint256", "uint256", "uint8", "bytes32"],
      [a, a, `Q${"0".repeat(128)}`, "9", "123", "1", h],
    );
    const result = decodeQrvmSwap(raw);
    assert.equal(result.recipient, `0x${a.slice(1)}`);
    assert.equal(result.amount, 9n);
    assert.equal(result.timeout, 123);
    assert.equal(result.status, 1);
    assert.equal(result.preimage, h);
    assert.throws(() => decodeQrvmSwap(raw.slice(0, -2)));
    assert.throws(() => decodeQrvmSwap(raw + "00"));
    assert.throws(() => decodeQrvmSwap(raw.slice(0, -1) + "1"));
  });
});

describe("market-maker v3 network identity", () => {
  const leg = { ns: "qrl" as const, url: "https://rpc.example", htlc: a };
  it("checks chain and genesis before v3 reads and refuses a changed endpoint", async () => {
    const original = globalThis.fetch;
    let genesis = protocolV2Config.qrlGenesisHash;
    try {
      globalThis.fetch = async (_url, init) => {
        const request = JSON.parse(String(init?.body)) as { method: string };
        return new Response(JSON.stringify({ result: request.method === "qrl_chainId" ? "0x301825" : { hash: genesis } }));
      };
      await assertQrlRuntime(leg);
      genesis = `0x${"0".repeat(64)}`;
      await assert.rejects(assertQrlRuntime(leg), /chain or genesis mismatch/);
    } finally { globalThis.fetch = original; }
  });
});
