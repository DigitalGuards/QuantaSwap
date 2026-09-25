import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  QIP55_DEPLOYMENT_ERROR,
  QIP55_PORTABLE_ORDER_ERROR,
  QRVM_ZERO_ADDRESS,
  assertPortableOrderV1CanSign,
  assertQip55ExecutionReady,
  canonicalQip55QrlAddress,
  deriveQip55Address,
  isQip55QrlAddress,
} from "./qip55.js";

describe("QIP-55 market-maker boundaries", () => {
  const account = `Q${"12".repeat(64)}`;
  const lowerAddress =
    "Qd5812f6cf4a0f645aa620cd57319a0ed649dd8f5519a9dde7770ae5b0e49e547985f35eb972a2a07041561aa39c65a3991478f9b1e6749e05277dcf58a9a8b72";
  const checksumAddress =
    "Qd5812F6Cf4a0f645aa620cd57319a0Ed649dd8f5519A9dde7770ae5b0E49e547985f35eB972A2a07041561aa39c65A3991478f9B1e6749e05277dcf58A9A8B72";

  it("canonicalizes Q plus exactly 64 bytes", () => {
    assert.equal(canonicalQip55QrlAddress(lowerAddress), checksumAddress);
    assert.equal(isQip55QrlAddress(`Q${lowerAddress.slice(1).toUpperCase()}`), true);
    assert.equal(isQip55QrlAddress(`QD${checksumAddress.slice(2)}`), false);
    assert.throws(
      () => canonicalQip55QrlAddress(`Q${"12".repeat(20)}`),
      new RegExp(QIP55_DEPLOYMENT_ERROR),
    );
  });

  it("derives a 64-byte descriptor and public-key binding", () => {
    const address = deriveQip55Address(new Uint8Array([1, 0, 0]), new Uint8Array(2592).fill(4));
    assert.match(address, /^Q[0-9a-fA-F]{128}$/);
    assert.equal(isQip55QrlAddress(address), true);
  });

  it("uses a 64-byte zero address word", () => {
    assert.equal(QRVM_ZERO_ADDRESS, `0x${"0".repeat(128)}`);
  });

  it("accepts portable V2 accounts and refuses legacy-width signing", () => {
    assert.doesNotThrow(() => assertPortableOrderV1CanSign(account));
    assert.throws(() => assertPortableOrderV1CanSign(`Q${"12".repeat(20)}`), new RegExp(QIP55_PORTABLE_ORDER_ERROR));
  });

  it("accepts full-width identities after QRVM64 codec qualification", () => {
    assert.doesNotThrow(() => assertQip55ExecutionReady(account, `Q${"34".repeat(64)}`));
    assert.throws(() => assertQip55ExecutionReady(`Q${"12".repeat(20)}`, `Q${"34".repeat(64)}`));
  });
});
