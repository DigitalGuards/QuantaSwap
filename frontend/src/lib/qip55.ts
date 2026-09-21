import { shake256 } from "@noble/hashes/sha3.js";
import { getBytes } from "ethers";

export const QRL_ADDRESS_RE = /^Q[0-9a-fA-F]{128}$/;
export const QRVM_ADDRESS_RE = /^0x[0-9a-fA-F]{128}$/;
export const LEGACY_QRL_ADDRESS_RE = /^Q[0-9a-fA-F]{40}$/;
export const QRVM_ZERO_ADDRESS = `0x${"0".repeat(128)}`;

export const QIP55_PORTABLE_ORDER_ERROR =
  "Portable V2 requires a QIP-55 64-byte QRL account";
export const QIP55_DEPLOYMENT_ERROR =
  "QIP-55 requires a fresh 64-byte QRL HTLC deployment before QRL swaps can run";
export const QIP55_QRVM_ABI_ERROR =
  "QIP-55 QRVM64 ABI support is required before QRL contract calls can be constructed";

const textEncoder = new TextEncoder();
const ML_DSA_DESCRIPTOR_BYTES = 3;
const ML_DSA_87_PUBLIC_KEY_BYTES = 2592;

/** Current Connect checksum semantics: hash the lowercase hexadecimal body
 * and use each SHAKE256 nibble to case the corresponding a-f character. */
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
  if (typeof value !== "string" || !QRL_ADDRESS_RE.test(value)) return false;
  const body = value.slice(1);
  const lower = body.toLowerCase();
  return body === lower || body === body.toUpperCase() || body === checksummedHex(lower);
}

export function isQrvmAddress(value: unknown): value is string {
  return typeof value === "string" && QRVM_ADDRESS_RE.test(value);
}

export function canonicalQip55QrlAddress(value: string): string {
  if (!isQip55QrlAddress(value)) {
    throw new Error(
      "Expected an uppercase Q prefix followed by a 64-byte address with a valid checksum",
    );
  }
  return `Q${checksummedHex(value.slice(1).toLowerCase())}`;
}

export function deriveQip55Address(descriptorHex: string, publicKeyHex: string): string {
  const descriptor = getBytes(descriptorHex);
  const publicKey = getBytes(publicKeyHex);
  if (
    descriptor.length !== ML_DSA_DESCRIPTOR_BYTES ||
    descriptor[0] !== 1 ||
    publicKey.length !== ML_DSA_87_PUBLIC_KEY_BYTES
  ) {
    throw new Error("QIP-55 identity binding requires an ML-DSA-87 descriptor and public key");
  }
  const input = new Uint8Array(descriptor.length + publicKey.length);
  input.set(descriptor);
  input.set(publicKey, descriptor.length);
  const digest = shake256(input, { dkLen: 64 });
  const lower = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `Q${checksummedHex(lower)}`;
}

export function assertPortableOrderV1CanSign(account: string): void {
  if (!isQip55QrlAddress(account)) throw new Error(QIP55_PORTABLE_ORDER_ERROR);
}

export function assertQip55ExecutionReady(account: string, htlc: string): void {
  assertQip55Deployment(htlc);
  if (!isQip55QrlAddress(account)) {
    throw new Error("QRL transaction sender must be an uppercase Q-prefixed 64-byte address");
  }
  if (LEGACY_QRL_ADDRESS_RE.test(htlc)) throw new Error(QIP55_DEPLOYMENT_ERROR);
  if (!isQip55QrlAddress(htlc)) {
    throw new Error("QRL HTLC must be an uppercase Q-prefixed 64-byte address with a valid checksum");
  }
}

export function assertQip55Deployment(htlc: string): void {
  if (!htlc || /^Q0{128}$/.test(htlc)) throw new Error(QIP55_DEPLOYMENT_ERROR);
  if (LEGACY_QRL_ADDRESS_RE.test(htlc)) throw new Error(QIP55_DEPLOYMENT_ERROR);
  if (!isQip55QrlAddress(htlc)) {
    throw new Error("QRL HTLC must be an uppercase Q-prefixed 64-byte address with a valid checksum");
  }
}

export function assertQip55ReadReady(htlc: string): void {
  assertQip55Deployment(htlc);
}
