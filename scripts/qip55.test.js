const { strict: assert } = require("node:assert");
const { describe, it } = require("node:test");
const {
  DEPLOYMENT_ERROR,
  QRVM_ZERO_ADDRESS,
  TOOLING_ERROR,
  assertQip55Deployment,
  assertQip55ToolingAccount,
  isQip55QrlAddress,
  qrvm64Topic,
} = require("./qip55");

describe("QIP-55 QRL script boundaries", () => {
  const account = `Q${"12".repeat(64)}`;
  const checksumAddress =
    "Qd5812F6Cf4a0f645aa620cd57319a0Ed649dd8f5519A9dde7770ae5b0E49e547985f35eB972A2a07041561aa39c65A3991478f9B1e6749e05277dcf58A9A8B72";

  it("accepts only uppercase Q plus exactly 64 bytes", () => {
    assert.equal(assertQip55ToolingAccount(account), account);
    assert.throws(
      () => assertQip55ToolingAccount(`Q${"12".repeat(20)}`),
      new RegExp(TOOLING_ERROR),
    );
    assert.throws(
      () => assertQip55Deployment(`Q${"34".repeat(20)}`),
      new RegExp(DEPLOYMENT_ERROR),
    );
    assert.equal(isQip55QrlAddress(checksumAddress), true);
    assert.equal(isQip55QrlAddress(`QD${checksumAddress.slice(2)}`), false);
  });

  it("uses 64-byte zero address and log topic words", () => {
    assert.equal(QRVM_ZERO_ADDRESS, `0x${"0".repeat(128)}`);
    assert.equal(
      qrvm64Topic(`0x${"ab".repeat(32)}`),
      `0x${"ab".repeat(32)}${"00".repeat(32)}`,
    );
  });
});
