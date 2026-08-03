import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  assertRuntimeChainIds,
  makeDeploymentIdentity,
  parseDeploymentIdentity,
  sameDeployment,
} from "./deployment.js";

const CONFIG = {
  ethChainId: "11155111",
  qrlChainId: "1337",
  ethHtlc: "0x910D5d4a7f2037c01F3B4C835167357e89909281",
  qrlHtlc: "Q238322ad2e8f935b4481fcc379779c31b84decb0",
};

describe("deployment identity", () => {
  it("canonicalizes addresses and chain IDs into a stable fingerprint", () => {
    const a = makeDeploymentIdentity(CONFIG);
    const b = makeDeploymentIdentity({
      ...CONFIG,
      ethChainId: "0xaa36a7",
      qrlChainId: "0x539",
      ethHtlc: CONFIG.ethHtlc.toLowerCase(),
      qrlHtlc: `Q${CONFIG.qrlHtlc.slice(1).toUpperCase()}`,
    });
    assert.ok(sameDeployment(a, b));
    assert.match(a.configFingerprint, /^sha256:[0-9a-f]{64}$/);
  });

  it("rejects a fingerprint that does not cover the stored fields", () => {
    const identity = makeDeploymentIdentity(CONFIG);
    assert.throws(
      () => parseDeploymentIdentity({ ...identity, ethChainId: "1" }, "test identity"),
      /fingerprint is invalid/,
    );
  });

  it("accepts the expected runtime chain IDs in RPC hexadecimal form", () => {
    assert.doesNotThrow(() =>
      assertRuntimeChainIds(makeDeploymentIdentity(CONFIG), "0xaa36a7", "0x539"),
    );
  });

  it("fails closed when either RPC is connected to another chain", () => {
    const identity = makeDeploymentIdentity(CONFIG);
    assert.throws(() => assertRuntimeChainIds(identity, "0x1", "0x539"), /RPC chain mismatch/);
    assert.throws(() => assertRuntimeChainIds(identity, "0xaa36a7", "0x1"), /RPC chain mismatch/);
  });
});
