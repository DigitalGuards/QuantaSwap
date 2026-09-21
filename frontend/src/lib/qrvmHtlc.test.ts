import { describe, expect, it } from "vitest";
import { encodeFunctionCall, encodeParameters } from "@theqrl/web3-qrl-abi";
import { decodeQrvmSwap, encodeQrvmHtlc, type QrvmHtlcMethod } from "./qrvmHtlc";

const hash = `0x${"12".repeat(32)}`;
const secret = `0x${"34".repeat(32)}`;
const account = `Q${"ab".repeat(64)}`;
const timeout = 1_800_007_200;
const cases: [QrvmHtlcMethod, string[], (string | number | bigint)[]][] = [
  ["lockNative", ["bytes32", "address", "uint256"], [hash, account, timeout]],
  ["lockNativeOpen", ["bytes32", "uint256"], [hash, timeout]],
  ["assign", ["bytes32", "address"], [hash, account]],
  ["claim", ["bytes32", "bytes32"], [hash, secret]],
  ["refund", ["bytes32"], [hash]],
  ["release", ["bytes32"], [hash]],
  ["getSwap", ["bytes32"], [hash]],
];

describe("bounded QRVM HTLC codec", () => {
  it.each(cases)("matches official web3 ABI for %s", (method, types, values) => {
    const reference = encodeFunctionCall({
      type: "function", name: method,
      inputs: types.map((type, index) => ({ name: `arg${index}`, type })),
    }, values.map(String));
    expect(encodeQrvmHtlc(method, values).toLowerCase()).toBe(reference.toLowerCase());
  });

  it("keeps all 64 address bytes significant", () => {
    const other = `Q${"ab".repeat(63)}cd`;
    expect(encodeQrvmHtlc("assign", [hash, account])).not.toBe(encodeQrvmHtlc("assign", [hash, other]));
    expect(encodeQrvmHtlc("assign", [hash, account]).slice(-128)).toBe(account.slice(1));
  });

  it("rejects legacy addresses, malformed bytes, and invalid integer bounds", () => {
    expect(() => encodeQrvmHtlc("assign", [hash, `Q${"ab".repeat(20)}`])).toThrow();
    expect(() => encodeQrvmHtlc("claim", [hash, "0x12"])).toThrow();
    for (const value of [-1, 1.1, Number.MAX_SAFE_INTEGER + 1, 1n << 256n, "-1", "1e3"]) {
      expect(() => encodeQrvmHtlc("lockNativeOpen", [hash, value])).toThrow();
    }
    expect(() => encodeQrvmHtlc("getSwap", [hash, hash])).toThrow();
  });

  const encodedSwap = () => encodeParameters(
    ["address", "address", "address", "uint256", "uint256", "uint8", "bytes32"],
    [account, `Q${"cd".repeat(64)}`, `Q${"0".repeat(128)}`, "1000000000000000000", String(timeout), "1", secret],
  );

  it("decodes the official ABI getSwap result without address truncation", () => {
    expect(decodeQrvmSwap(encodedSwap())).toEqual({
      initiator: `0x${"ab".repeat(64)}`, recipient: `0x${"cd".repeat(64)}`,
      token: `0x${"0".repeat(128)}`, amount: 10n ** 18n, timeout,
      status: 1, preimage: secret,
    });
  });

  it("rejects wrong word width, padded overflow, invalid status, and bytes32 tails", () => {
    const raw = encodedSwap();
    expect(() => decodeQrvmSwap(raw.slice(0, -2))).toThrow();
    expect(() => decodeQrvmSwap(raw + "00")).toThrow();
    expect(() => decodeQrvmSwap(raw.slice(0, 2 + 3 * 128) + "1" + raw.slice(3 + 3 * 128))).toThrow(/padding/);
    expect(() => decodeQrvmSwap(raw.slice(0, 2 + 5 * 128) + "4".padStart(128, "0") + raw.slice(2 + 6 * 128))).toThrow(/status/);
    expect(() => decodeQrvmSwap(raw.slice(0, -1) + "1")).toThrow(/padding/);
  });
});
