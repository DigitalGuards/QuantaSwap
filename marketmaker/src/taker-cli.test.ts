// Argument parsing for the taker CLI. A limit flag that silently loses its
// value would change how much this client is willing to escrow, so the
// parser refuses anything ambiguous.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { parseArgs } from "./taker-cli.js";

describe("taker CLI arguments", () => {
  it("reads a command with its positional argument", () => {
    const args = parseArgs(["quote", "abc123"]);
    assert.equal(args.command, "quote");
    assert.deepEqual(args.positional, ["abc123"]);
  });

  it("reads limits in both spellings", () => {
    const spaced = parseArgs(["take", "id", "--max-in", "1.5"]);
    assert.equal(spaced.flags.get("max-in"), "1.5");
    const inline = parseArgs(["take", "id", "--max-in=1.5"]);
    assert.equal(inline.flags.get("max-in"), "1.5");
  });

  it("refuses a limit flag with no value", () => {
    assert.throws(() => parseArgs(["take", "id", "--max-in"]), /needs a value/);
    assert.throws(
      () => parseArgs(["take", "id", "--max-in", "--yes"]),
      /needs a value/,
    );
  });

  it("reads boolean safety flags", () => {
    const args = parseArgs(["take", "id", "--yes", "--dry-run"]);
    assert.equal(args.flags.get("yes"), true);
    assert.equal(args.flags.get("dry-run"), true);
    assert.equal(args.flags.has("json"), false);
  });

  it("keeps an empty command line empty", () => {
    const args = parseArgs([]);
    assert.equal(args.command, "");
    assert.deepEqual(args.positional, []);
  });
});
