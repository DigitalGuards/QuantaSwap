import { createHash } from "node:crypto";

export const QIP55_QRL_ADDRESS_RE = /^Q[0-9a-fA-F]{128}$/;
export const LEGACY_QRL_ADDRESS_RE = /^Q[0-9a-fA-F]{40}$/;
export const QRVM_ADDRESS_RE = /^0x[0-9a-fA-F]{128}$/;
export const ETH_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
export const QRVM_ZERO_ADDRESS = `0x${"0".repeat(128)}`;

export const QIP55_PORTABLE_ORDER_ERROR =
  "Portable V2 requires a QIP-55 64-byte QRL account";
export const QIP55_DEPLOYMENT_ERROR =
  "QIP-55 requires a fresh 64-byte QRL HTLC deployment";
export const QIP55_QRVM_ABI_ERROR =
  "QIP-55 QRVM64 ABI support is required before QRL contract calls can be constructed";
const ML_DSA_DESCRIPTOR_BYTES = 3;
const ML_DSA_87_PUBLIC_KEY_BYTES = 2592;

/** Current Connect checksum semantics for mixed-case QIP-55 input. */
function checksummedHex(lowerHex: string): string {
  const hash = createHash("shake256", { outputLength: 64 }).update(lowerHex).digest();
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
  if (typeof value !== "string" || !QIP55_QRL_ADDRESS_RE.test(value)) return false;
  const body = value.slice(1);
  const lower = body.toLowerCase();
  return body === lower || body === body.toUpperCase() || body === checksummedHex(lower);
}

export function canonicalQip55QrlAddress(value: string): string {
  if (!isQip55QrlAddress(value)) {
    if (LEGACY_QRL_ADDRESS_RE.test(value)) throw new Error(QIP55_DEPLOYMENT_ERROR);
    throw new Error(
      "QRL address must use an uppercase Q prefix followed by 64 bytes with a valid checksum",
    );
  }
  return `Q${checksummedHex(value.slice(1).toLowerCase())}`;
}

export function deriveQip55Address(descriptor: Uint8Array, publicKey: Uint8Array): string {
  if (
    descriptor.length !== ML_DSA_DESCRIPTOR_BYTES ||
    descriptor[0] !== 1 ||
    publicKey.length !== ML_DSA_87_PUBLIC_KEY_BYTES
  ) {
    throw new Error("QIP-55 identity binding requires an ML-DSA-87 descriptor and public key");
  }
  const digest = createHash("shake256", { outputLength: 64 })
    .update(descriptor)
    .update(publicKey)
    .digest("hex");
  return `Q${checksummedHex(digest)}`;
}

export function assertPortableOrderV1CanSign(account: string): void {
  if (!isQip55QrlAddress(account)) throw new Error(QIP55_PORTABLE_ORDER_ERROR);
}

export function assertQip55ExecutionReady(account: string, htlc: string): void {
  canonicalQip55QrlAddress(account);
  canonicalQip55QrlAddress(htlc);
}

export function assertQip55ReadReady(htlc: string): void {
  canonicalQip55QrlAddress(htlc);
}

export function assertQip55Deployment(htlc: string): void {
  canonicalQip55QrlAddress(htlc);
}

export function qrlOrEthHex(address: string): string {
  if (isQip55QrlAddress(address)) return `0x${address.slice(1)}`;
  if (QRVM_ADDRESS_RE.test(address) || ETH_ADDRESS_RE.test(address)) return address;
  throw new Error("address must be QRL 64-byte, QRVM 64-byte, or Ethereum 20-byte hex");
}
