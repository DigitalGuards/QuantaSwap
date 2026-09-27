// Argument parsing, limit scaling and exit codes for the taker CLI. A limit
// that silently loses its value or its sign would change how much this
// client is willing to escrow, and a status code is what a supervisor acts
// on, so both are pinned here.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  EXIT_CLAIMED,
  EXIT_IN_FLIGHT,
  EXIT_REFUNDED,
  EXIT_RELEASED,
  EXIT_UNEVEN,
  EXIT_UNFUNDED,
  boundsFor,
  confirm,
  creditLedgerKey,
  destinationFitsLeg,
  parseArgs,
  takeExitCode,
} from "./taker-cli.js";

/** Quote shapes for the two pairs whose decimals differ. */
const QRL_FOR_ETH = { pay: { decimals: 18 }, receive: { decimals: 18 } };
const USDC_FOR_QRL = { pay: { decimals: 6 }, receive: { decimals: 18 } };

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

  it("reads the withdrawal destination as a valued flag", () => {
    // --to carries an address, so it must consume the next token instead of
    // being read as a boolean and swallowing the value.
    const spaced = parseArgs(["withdraw", "--to", `0x${"a".repeat(40)}`]);
    assert.equal(spaced.command, "withdraw");
    assert.equal(spaced.flags.get("to"), `0x${"a".repeat(40)}`);
    assert.deepEqual(spaced.positional, []);
    const scoped = parseArgs(["withdraw", "abc123", `--to=Q${"b".repeat(128)}`]);
    assert.deepEqual(scoped.positional, ["abc123"]);
    assert.equal(scoped.flags.get("to"), `Q${"b".repeat(128)}`);
    assert.throws(() => parseArgs(["withdraw", "--to"]), /needs a value/);
  });

  it("applies a withdrawal destination only to the leg that can encode it", () => {
    // The two legs use different address formats, so one --to cannot serve
    // both. A destination the leg cannot pay leaves that credit in place.
    const eth = `0x${"a".repeat(40)}`;
    const qrl = `Q${"b".repeat(128)}`;
    assert.equal(destinationFitsLeg(eth, "eth"), true);
    assert.equal(destinationFitsLeg(eth, "qrl"), false);
    assert.equal(destinationFitsLeg(qrl, "qrl"), true);
    assert.equal(destinationFitsLeg(qrl, "eth"), false);
    assert.equal(destinationFitsLeg("nonsense", "eth"), false);
    assert.equal(destinationFitsLeg("nonsense", "qrl"), false);
  });

  it("keys a credit on the ledger entry it moves", () => {
    // withdrawAll and pushCredit move a (token, account) balance, so two
    // takes that settled with the same counterparty on the same asset share
    // one credit. Counting it per record would report and move it twice.
    const line = {
      leg: "eth" as const,
      token: `0x${"0".repeat(40)}`,
      account: `0x${"AB".repeat(20)}`,
    };
    assert.equal(
      creditLedgerKey(line),
      creditLedgerKey({ ...line, account: line.account.toLowerCase() }),
    );
    assert.notEqual(creditLedgerKey(line), creditLedgerKey({ ...line, leg: "qrl" }));
    assert.notEqual(
      creditLedgerKey(line),
      creditLedgerKey({ ...line, token: `0x${"1".repeat(40)}` }),
    );
  });

  it("keeps an empty command line empty", () => {
    const args = parseArgs([]);
    assert.equal(args.command, "");
    assert.deepEqual(args.positional, []);
  });
});

describe("take limits", () => {
  it("scales each limit by the decimals of its own leg", () => {
    const bounds = boundsFor(
      parseArgs(["take", "id", "--max-in", "2.5", "--min-out", "0.02"]),
      USDC_FOR_QRL,
    );
    assert.equal(bounds.maxIn, 2_500_000n);
    assert.equal(bounds.minOut, 20_000_000_000_000_000n);
  });

  it("scales an 18 decimal pair", () => {
    const bounds = boundsFor(
      parseArgs(["take", "id", "--max-in", "250"]),
      QRL_FOR_ETH,
    );
    assert.equal(bounds.maxIn, 250n * 10n ** 18n);
    assert.equal(bounds.minOut, undefined);
  });

  it("refuses a negative limit, which would remove the bound", () => {
    for (const flag of ["--max-in", "--min-out"]) {
      assert.throws(
        () => boundsFor(parseArgs(["take", "id", flag, "-1"]), QRL_FOR_ETH),
        /greater than zero/,
      );
    }
  });

  it("refuses a zero limit", () => {
    assert.throws(
      () => boundsFor(parseArgs(["take", "id", "--max-in", "0"]), QRL_FOR_ETH),
      /greater than zero/,
    );
    assert.throws(
      () =>
        boundsFor(parseArgs(["take", "id", "--min-out", "0.0"]), QRL_FOR_ETH),
      /greater than zero/,
    );
  });

  it("refuses a limit that is not an amount", () => {
    assert.throws(
      () => boundsFor(parseArgs(["take", "id", "--max-in", "lots"]), QRL_FOR_ETH),
      /decimal amount/,
    );
  });

  it("refuses more precision than the leg has", () => {
    assert.throws(
      () =>
        boundsFor(
          parseArgs(["take", "id", "--max-in", "1.0000001"]),
          USDC_FOR_QRL,
        ),
      /decimal amount/,
    );
  });

  it("omits a bound that was not given", () => {
    assert.deepEqual(boundsFor(parseArgs(["take", "id"]), QRL_FOR_ETH), {});
  });
});

describe("exit codes", () => {
  it("maps every outcome to its own status", () => {
    assert.equal(takeExitCode("claimed"), EXIT_CLAIMED);
    assert.equal(takeExitCode("refunded"), EXIT_REFUNDED);
    assert.equal(takeExitCode("released"), EXIT_RELEASED);
    assert.equal(takeExitCode("aborted"), EXIT_UNFUNDED);
    assert.equal(takeExitCode("uneven"), EXIT_UNEVEN);
    assert.equal(takeExitCode(null), EXIT_IN_FLIGHT);
  });

  it("keeps a refund distinct from a take that never funded", () => {
    assert.notEqual(takeExitCode("refunded"), takeExitCode("aborted"));
    assert.notEqual(takeExitCode(null), takeExitCode("claimed"));
  });
});

describe("confirmation", () => {
  it("refuses to fund without a terminal, naming the flag to pass", async () => {
    // node:test runs without a TTY on stdin, which is the case that matters:
    // a scripted run must opt in explicitly.
    assert.notEqual(process.stdin.isTTY, true);
    await assert.rejects(confirm("continue? "), /--yes/);
  });
});
