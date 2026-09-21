import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { shake256 } from "@noble/hashes/sha3.js";
import {
  QIP55_PORTABLE_ORDER_ERROR,
  QRVM_ZERO_ADDRESS,
  assertLegacyOrderProtocolInput,
  deriveQip55Address,
  isQip55QrlAddress,
} from "./qip55.js";

describe("QIP-55 order-book boundaries", () => {
  const account = `Q${"12".repeat(64)}`;
  const checksumAddress =
    "Qd5812F6Cf4a0f645aa620cd57319a0Ed649dd8f5519A9dde7770ae5b0E49e547985f35eB972A2a07041561aa39c65A3991478f9B1e6749e05277dcf58A9A8B72";

  it("accepts an uppercase Q prefix followed by exactly 64 bytes", () => {
    assert.equal(isQip55QrlAddress(account), true);
    assert.equal(isQip55QrlAddress(`Q${"12".repeat(20)}`), false);
    assert.equal(isQip55QrlAddress(`q${"12".repeat(64)}`), false);
    assert.equal(isQip55QrlAddress(checksumAddress), true);
    assert.equal(isQip55QrlAddress(`QD${checksumAddress.slice(2)}`), false);
  });

  it("derives descriptor and public-key identity with SHAKE256-64", () => {
    const descriptor = Buffer.from([1, 0, 0]);
    const publicKey = Buffer.alloc(2592, 9);
    const expected = `Q${Buffer.from(
      shake256(Buffer.concat([descriptor, publicKey]), { dkLen: 64 }),
    ).toString("hex")}`;
    const derived = deriveQip55Address(
      `0x${descriptor.toString("hex")}`,
      `0x${publicKey.toString("hex")}`,
    );
    assert.equal(derived.toLowerCase(), expected.toLowerCase());
    assert.equal(isQip55QrlAddress(derived), true);
  });

  it("uses a 64-byte zero address word", () => {
    assert.equal(QRVM_ZERO_ADDRESS, `0x${"0".repeat(128)}`);
  });

  it("accepts v3 accounts and refuses legacy-width order inputs", () => {
    assert.doesNotThrow(() => assertLegacyOrderProtocolInput(account));
    assert.throws(
      () => assertLegacyOrderProtocolInput(`Q${"12".repeat(20)}`),
      new RegExp(QIP55_PORTABLE_ORDER_ERROR),
    );
  });
});
