import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeOperatorSecrets, type OperatorKeys } from "./init-keys.js";

const KEYS: OperatorKeys = {
  ethPrivateKey: `0x${"1".repeat(64)}`,
  ethAddress: `0x${"2".repeat(40)}`,
  qrlHexseed: `0x${"3".repeat(102)}`,
  qrlAddress: `Q${"4".repeat(40)}`,
};

describe("operator key initialization", () => {
  it("writes a private directory and two mode-0600 secret files", () => {
    const root = mkdtempSync(join(tmpdir(), "mm-keys-test-"));
    const dir = join(root, "secrets");
    try {
      const paths = writeOperatorSecrets(dir, KEYS);
      assert.equal(statSync(dir).mode & 0o777, 0o700);
      assert.equal(statSync(paths.ethPrivateKey).mode & 0o777, 0o600);
      assert.equal(statSync(paths.qrlHexseed).mode & 0o777, 0o600);
      assert.equal(readFileSync(paths.ethPrivateKey, "utf8"), `${KEYS.ethPrivateKey}\n`);
      assert.equal(readFileSync(paths.qrlHexseed, "utf8"), `${KEYS.qrlHexseed}\n`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses overwrite and removes a newly created half-pair", () => {
    const root = mkdtempSync(join(tmpdir(), "mm-keys-test-"));
    const dir = join(root, "secrets");
    try {
      mkdirSync(dir, { mode: 0o700 });
      const qrlPath = join(dir, "qrl-hexseed");
      writeFileSync(qrlPath, "existing\n", { mode: 0o600 });
      assert.throws(() => writeOperatorSecrets(dir, KEYS), /EEXIST/);
      assert.equal(readFileSync(qrlPath, "utf8"), "existing\n");
      assert.throws(() => statSync(join(dir, "eth-private-key")), /ENOENT/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
