import { shake256 } from "@noble/hashes/sha3.js";
import { getBytes } from "ethers";
import { ApiError } from "./errors.js";

export const QIP55_QRL_ADDRESS_RE = /^Q[0-9a-fA-F]{128}$/;
export const QRVM_ZERO_ADDRESS = `0x${"0".repeat(128)}`;
export const QIP55_PORTABLE_ORDER_ERROR =
  "The v3 order book requires a QIP-55 64-byte QRL account";

const textEncoder = new TextEncoder();
const ML_DSA_DESCRIPTOR_BYTES = 3;
const ML_DSA_87_PUBLIC_KEY_BYTES = 2592;

/** Current Connect checksum semantics for mixed-case QIP-55 input. */
function checksummedHex(lowerHex: string): string {
  const hash = shake256(textEncoder.encode(lowerHex), { dkLen: 64 });
  let result = "";
  for (let index = 0; index < lowerHex.length; index += 1) {
    const char = lowerHex[index] ?? "";
    if (char >= "a" && char <= "f") {
      const byte = hash[index >> 1] ?? 0;
      const nibble = (index & 1) === 0 ? byte >> 4 : byte & 0x0f;
      result += nibble >= 8 ? char.toUpperCase() : char;
    } else {
      result += char;
    }
  }
  return result;
}

export function isQip55QrlAddress(value: unknown): value is string {
  if (typeof value !== "string" || !QIP55_QRL_ADDRESS_RE.test(value))
    return false;
  const body = value.slice(1);
  const lower = body.toLowerCase();
  return (
    body === lower ||
    body === body.toUpperCase() ||
    body === checksummedHex(lower)
  );
}

export function deriveQip55Address(
  descriptorHex: string,
  publicKeyHex: string,
): string {
  const descriptor = getBytes(descriptorHex);
  const publicKey = getBytes(publicKeyHex);
  if (
    descriptor.length !== ML_DSA_DESCRIPTOR_BYTES ||
    descriptor[0] !== 1 ||
    publicKey.length !== ML_DSA_87_PUBLIC_KEY_BYTES
  ) {
    throw new Error(
      "QIP-55 identity binding requires an ML-DSA-87 descriptor and public key",
    );
  }
  const input = new Uint8Array(descriptor.length + publicKey.length);
  input.set(descriptor);
  input.set(publicKey, descriptor.length);
  const digest = shake256(input, { dkLen: 64 });
  return `Q${checksummedHex(Buffer.from(digest).toString("hex"))}`;
}

export function assertLegacyOrderProtocolInput(account: unknown): void {
  if (!isQip55QrlAddress(account)) {
    throw new ApiError(409, QIP55_PORTABLE_ORDER_ERROR);
  }
}
