import { shake256 } from "@noble/hashes/sha3.js";
import { describe, expect, it } from "vitest";
import {
  QIP55_DEPLOYMENT_ERROR,
  QIP55_PORTABLE_ORDER_ERROR,
  QRVM_ZERO_ADDRESS,
  assertPortableOrderV1CanSign,
  assertQip55ExecutionReady,
  canonicalQip55QrlAddress,
  deriveQip55Address,
  isQip55QrlAddress,
} from "./qip55";

describe("QIP-55 capability boundaries", () => {
  const account = `Q${"12".repeat(64)}`;
  const lowerAddress =
    "Qd5812f6cf4a0f645aa620cd57319a0ed649dd8f5519a9dde7770ae5b0e49e547985f35eb972a2a07041561aa39c65a3991478f9b1e6749e05277dcf58a9a8b72";
  const checksumAddress =
    "Qd5812F6Cf4a0f645aa620cd57319a0Ed649dd8f5519A9dde7770ae5b0E49e547985f35eB972A2a07041561aa39c65A3991478f9B1e6749e05277dcf58A9A8B72";

  it("validates mixed-case QIP-55 checksum casing", () => {
    expect(isQip55QrlAddress(lowerAddress)).toBe(true);
    expect(isQip55QrlAddress(`Q${lowerAddress.slice(1).toUpperCase()}`)).toBe(true);
    expect(isQip55QrlAddress(checksumAddress)).toBe(true);
    expect(isQip55QrlAddress(`QD${checksumAddress.slice(2)}`)).toBe(false);
    expect(canonicalQip55QrlAddress(lowerAddress)).toBe(checksumAddress);
  });

  it("derives descriptor and public-key identity with a 64-byte SHAKE256 output", () => {
    const descriptor = new Uint8Array([1, 0, 0]);
    const publicKey = new Uint8Array(2592).fill(7);
    const input = new Uint8Array(descriptor.length + publicKey.length);
    input.set(descriptor);
    input.set(publicKey, descriptor.length);
    const expected = `Q${Array.from(shake256(input, { dkLen: 64 }), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("")}`;
    const derived = deriveQip55Address(
      `0x${Buffer.from(descriptor).toString("hex")}`,
      `0x${Buffer.from(publicKey).toString("hex")}`,
    );
    expect(derived.toLowerCase()).toBe(expected.toLowerCase());
    expect(isQip55QrlAddress(derived)).toBe(true);
  });

  it("uses a 64-byte zero address word", () => {
    expect(QRVM_ZERO_ADDRESS).toBe(`0x${"0".repeat(128)}`);
  });

  it("accepts QIP-55 for portable V2 and rejects legacy accounts", () => {
    expect(() => assertPortableOrderV1CanSign(account)).not.toThrow();
    expect(() => assertPortableOrderV1CanSign(`Q${"12".repeat(20)}`)).toThrow(QIP55_PORTABLE_ORDER_ERROR);
  });

  it("blocks the current Q40 HTLC before any QRL RPC or wallet send", () => {
    expect(() =>
      assertQip55ExecutionReady(account, `Q${"34".repeat(20)}`),
    ).toThrow(QIP55_DEPLOYMENT_ERROR);
  });

  it("allows validated full-width accounts and a fresh Q+128 deployment", () => {
    expect(() => assertQip55ExecutionReady(account, `Q${"34".repeat(64)}`)).not.toThrow();
    expect(() => assertQip55ExecutionReady(account, "")).toThrow(QIP55_DEPLOYMENT_ERROR);
    expect(() => assertQip55ExecutionReady(account, `Q${"0".repeat(128)}`)).toThrow(QIP55_DEPLOYMENT_ERROR);
  });
});
