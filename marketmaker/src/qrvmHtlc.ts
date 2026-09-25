// Bounded QRVM-512 ABI codec for the static HTLC surface. Ethereum keeps
// its separate ethers codec. Each QRVM argument occupies one 64-byte word.
import { id } from "ethers";
import { canonicalQip55QrlAddress } from "./qip55.js";

const METHODS = {
  lockNative: ["bytes32", "address", "uint256"],
  lockNativeOpen: ["bytes32", "uint256"],
  assign: ["bytes32", "address"],
  release: ["bytes32"],
  claim: ["bytes32", "bytes32"],
  refund: ["bytes32"],
  getSwap: ["bytes32"],
} as const;

export type QrvmHtlcMethod = keyof typeof METHODS;

export function encodeQrvmHtlc(
  method: QrvmHtlcMethod,
  values: readonly (string | number | bigint)[],
): string {
  const types = METHODS[method];
  if (values.length !== types.length) throw new Error("Invalid QRVM HTLC argument count");
  const words = types.map((type, index) => {
    const value = values[index];
    if (type === "bytes32") {
      if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
        throw new Error("QRVM HTLC bytes32 must contain exactly 32 bytes");
      }
      return value.slice(2).toLowerCase().padEnd(128, "0");
    }
    if (type === "address") {
      if (typeof value !== "string") throw new Error("Invalid QRVM HTLC address");
      return canonicalQip55QrlAddress(value).slice(1).toLowerCase();
    }
    if (
      value === undefined ||
      (typeof value === "number" && !Number.isSafeInteger(value)) ||
      (typeof value === "string" && !/^(?:0|[1-9][0-9]*|0x[0-9a-fA-F]+)$/.test(value))
    ) {
      throw new Error("Invalid QRVM HTLC uint256");
    }
    const number = BigInt(value);
    if (number < 0n || number >= 1n << 256n) throw new Error("QRVM HTLC uint256 out of range");
    return number.toString(16).padStart(128, "0");
  });
  return id(`${method}(${types.join(",")})`).slice(0, 10) + words.join("");
}

export interface QrvmSwap {
  initiator: string;
  recipient: string;
  token: string;
  amount: bigint;
  timeout: number;
  status: 0 | 1 | 2 | 3;
  preimage: string;
}

export function decodeQrvmSwap(raw: unknown): QrvmSwap {
  if (typeof raw !== "string" || !/^0x[0-9a-fA-F]{896}$/.test(raw)) {
    throw new Error("QRVM getSwap must return exactly seven 64-byte words");
  }
  const word = (index: number): string => raw.slice(2 + index * 128, 2 + (index + 1) * 128).toLowerCase();
  const uint256 = (index: number): bigint => {
    const value = word(index);
    if (!/^0{64}/.test(value)) throw new Error("Noncanonical QRVM uint256 padding");
    return BigInt(`0x${value}`);
  };
  const amount = uint256(3);
  const timeout = uint256(4);
  const status = uint256(5);
  if (timeout > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Unsafe QRVM timeout");
  if (status > 3n) throw new Error("Unknown QRVM swap status");
  const preimage = word(6);
  if (!/0{64}$/.test(preimage)) throw new Error("Noncanonical QRVM bytes32 padding");
  return {
    initiator: `0x${word(0)}`,
    recipient: `0x${word(1)}`,
    token: `0x${word(2)}`,
    amount,
    timeout: Number(timeout),
    status: Number(status) as QrvmSwap["status"],
    preimage: `0x${preimage.slice(0, 64)}`,
  };
}
