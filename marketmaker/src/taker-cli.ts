// Command line entry point for the scripted taker: list, quote, take,
// resume, status and release. Key material is only loaded by the commands
// that sign or send, and no command ever prints a secret.

import { parseUnits } from "ethers";
import { pathToFileURL } from "node:url";
import { EthLeg, QrlLeg } from "./chains.js";
import {
  assertPortableDeployment,
  assertRuntimeChainIds,
  makeDeploymentIdentity,
} from "./deployment.js";
import { getChainId, type LegKey, type LegRpc } from "./htlc.js";
import { ProtocolSigner } from "./protocol-signing.js";
import { StateProcessLease } from "./state.js";
import {
  loadTakerConfig,
  loadTakerReadConfig,
  type TakerConfig,
  type TakerReadConfig,
} from "./taker-config.js";
import { TakerBookClient } from "./taker-orderbook.js";
import { TakerEngine, type TakeBounds } from "./taker.js";
import { TakerStateFile, type TakerOutcome } from "./taker-state.js";

const USAGE = `QuantaSwap scripted taker

Usage:
  taker list [--json]
  taker quote <orderId> [--max-in <amount>] [--min-out <amount>] [--json]
  taker take <orderId> [--max-in <amount>] [--min-out <amount>] [--yes] [--dry-run] [--once]
  taker resume [--dry-run] [--once]
  taker status [--json]
  taker release <orderId> [--dry-run]

Amounts for --max-in and --min-out are whole units of the asset on that
leg (QRL on the QRL leg, ETH or the token symbol on the Ethereum leg).

Exit status: 0 claimed, 1 ended without funding, 2 uneven settlement,
3 still in flight (run resume), 4 refunded, 5 released.

Configuration comes from TAKER_* environment variables; see
../docs/TAKERS.md and .env.taker.example. list and quote need no keys.`;

export const EXIT_CLAIMED = 0;
export const EXIT_UNFUNDED = 1;
export const EXIT_UNEVEN = 2;
export const EXIT_IN_FLIGHT = 3;
export const EXIT_REFUNDED = 4;
export const EXIT_RELEASED = 5;

/** One outcome, one status code, so a supervisor can act on it. */
export function takeExitCode(outcome: TakerOutcome | null): number {
  switch (outcome) {
    case null:
      return EXIT_IN_FLIGHT;
    case "claimed":
      return EXIT_CLAIMED;
    case "uneven":
      return EXIT_UNEVEN;
    case "refunded":
      return EXIT_REFUNDED;
    case "released":
      return EXIT_RELEASED;
    case "aborted":
    default:
      return EXIT_UNFUNDED;
  }
}

interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Map<string, string | true>;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  const valued = new Set(["max-in", "min-out"]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const name = token.slice(2);
    const inline = name.indexOf("=");
    if (inline !== -1) {
      flags.set(name.slice(0, inline), name.slice(inline + 1));
      continue;
    }
    if (valued.has(name)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`--${name} needs a value`);
      }
      flags.set(name, value);
      index += 1;
      continue;
    }
    flags.set(name, true);
  }
  const command = positional.shift() ?? "";
  return { command, positional, flags };
}

function flagValue(args: ParsedArgs, name: string): string | null {
  const value = args.flags.get(name);
  if (value === undefined) return null;
  if (value === true) throw new Error(`--${name} needs a value`);
  return value;
}

function bookFor(cfg: TakerReadConfig): TakerBookClient {
  return new TakerBookClient(cfg.orderbookUrl, cfg.netTimeoutMs);
}

function legRpcFor(cfg: TakerReadConfig): Record<LegKey, LegRpc> {
  return {
    eth: {
      url: cfg.ethRpcUrl,
      ns: "eth",
      htlc: cfg.ethHtlc,
      timeoutMs: cfg.netTimeoutMs,
    },
    qrl: {
      url: cfg.qrlRpcUrl,
      ns: "qrl",
      htlc: cfg.qrlHtlc,
      timeoutMs: cfg.netTimeoutMs,
    },
  };
}

function readOnlyEngine(cfg: TakerReadConfig): TakerEngine {
  return new TakerEngine({ cfg, book: bookFor(cfg), legRpc: legRpcFor(cfg) });
}

interface SigningSession {
  engine: TakerEngine;
  cfg: TakerConfig;
  close(): void;
}

/** Build a signing engine: keys, chain senders, the exclusive state lease
 *  and the durable state file. The lease is released by close(). */
async function signingSession(
  cfg: TakerConfig,
  options: {
    dryRun?: boolean;
    verifyChains?: boolean;
    /** A read-only session takes no lease and writes nothing, so `status`
     *  works while a take runs and a dry run leaves no lock file behind. */
    readOnly?: boolean;
  } = {},
): Promise<SigningSession> {
  const dryRun = options.dryRun === true;
  const readOnly = options.readOnly === true || dryRun;
  const deployment = makeDeploymentIdentity(cfg);
  assertPortableDeployment(deployment);
  const eth = new EthLeg(cfg);
  const qrl = new QrlLeg(cfg);
  const signer = new ProtocolSigner(cfg.qrlHexseed);
  if (signer.address.toLowerCase() !== qrl.address.toLowerCase()) {
    signer.close();
    throw new Error(
      "the protocol signer address does not match the QRL transaction signer",
    );
  }
  const lease = readOnly
    ? null
    : StateProcessLease.acquire(cfg.stateFile, {
        deploymentFingerprint: deployment.configFingerprint,
        ethAccount: eth.address.toLowerCase(),
        qrlAccount: signer.address.toLowerCase(),
      });
  const identity = { ethAccount: eth.address, qrlAccount: signer.address };
  let state: TakerStateFile;
  try {
    state = new TakerStateFile(
      cfg.stateFile,
      deployment,
      lease === null
        ? () => {
            throw new Error(
              "this session is read-only and holds no state lease, so it must not write state",
            );
          }
        : () => lease.assertOwned(),
      identity,
    );
  } catch (error) {
    lease?.close();
    signer.close();
    throw error;
  }
  const legRpc = legRpcFor(cfg);
  // Fail before any signing or send if an endpoint is connected to a
  // different chain than the persisted deployment identity.
  if (options.verifyChains !== false) {
    try {
      const [ethChainId, qrlChainId] = await Promise.all([
        getChainId(legRpc.eth),
        getChainId(legRpc.qrl),
      ]);
      assertRuntimeChainIds(deployment, ethChainId, qrlChainId);
    } catch (error) {
      lease?.close();
      signer.close();
      throw error;
    }
  }
  const engine = new TakerEngine({
    cfg,
    book: bookFor(cfg),
    legRpc,
    signing: { signer, eth, qrl, state, deployment },
    ...(dryRun ? { dryRun: true } : {}),
  });
  return {
    engine,
    cfg,
    close: () => {
      signer.close();
      lease?.close();
    },
  };
}

/** Parse a limit in whole units of the leg it applies to. A limit at or
 *  below zero would silently remove the bound it was meant to add. */
function limit(
  args: ParsedArgs,
  name: "max-in" | "min-out",
  decimals: number,
): bigint | null {
  const raw = flagValue(args, name);
  if (raw === null) return null;
  let value: bigint;
  try {
    value = parseUnits(raw, decimals);
  } catch {
    throw new Error(`--${name} must be a decimal amount, for example 1.5`);
  }
  if (value <= 0n) throw new Error(`--${name} must be greater than zero`);
  return value;
}

/** Limits are scaled by the decimals of the verified order's own legs. */
export function boundsFor(
  args: ParsedArgs,
  quote: { pay: { decimals: number }; receive: { decimals: number } },
): TakeBounds {
  const maxIn = limit(args, "max-in", quote.pay.decimals);
  const minOut = limit(args, "min-out", quote.receive.decimals);
  return {
    ...(maxIn === null ? {} : { maxIn }),
    ...(minOut === null ? {} : { minOut }),
  };
}

async function commandList(args: ParsedArgs): Promise<number> {
  const cfg = loadTakerReadConfig();
  const { quotes, skipped } = await readOnlyEngine(cfg).list();
  if (args.flags.has("json")) {
    console.log(JSON.stringify({ orders: quotes, skipped }, jsonReplacer, 2));
    return 0;
  }
  if (quotes.length === 0) {
    console.log("No verified portable orders are open on this book.");
  }
  for (const quote of quotes) {
    console.log(
      [
        quote.id.slice(0, 12),
        `${quote.direction}`,
        `pay ${quote.pay.display}`,
        `receive ${quote.receive.display}`,
        `price ${quote.price} ${quote.receive.symbol}/${quote.pay.symbol}`,
        `expires ${new Date(quote.expiresAt * 1000).toISOString()}`,
        `maker ${quote.makerQrlAccount.slice(0, 10)}`,
        quote.makerSeen === false ? "maker offline" : "",
        quote.prelocked ? "pre-funded" : "",
        quote.issue === null ? "" : `unavailable: ${quote.issue}`,
      ]
        .filter((part) => part !== "")
        .join("  "),
    );
  }
  if (skipped > 0) {
    console.log(`${skipped} row(s) skipped: no valid portable maker proof.`);
  }
  return 0;
}

async function commandQuote(args: ParsedArgs): Promise<number> {
  const orderId = args.positional[0];
  if (orderId === undefined) throw new Error("quote needs an order id");
  const cfg = loadTakerReadConfig();
  const engine = readOnlyEngine(cfg);
  const preview = await engine.quote(orderId);
  const quote = await engine.quote(orderId, boundsFor(args, preview));
  if (args.flags.has("json")) {
    console.log(JSON.stringify(quote, jsonReplacer, 2));
    return quote.issue === null ? 0 : 1;
  }
  console.log(`order        ${quote.id}`);
  console.log(`direction    ${quote.direction} (${quote.asset} leg)`);
  console.log(`you lock     ${quote.pay.display} on the ${quote.pay.leg} leg`);
  console.log(
    `you receive  ${quote.receive.display} on the ${quote.receive.leg} leg`,
  );
  console.log(
    `price        ${quote.price} ${quote.receive.symbol} per ${quote.pay.symbol}`,
  );
  console.log(`maker        ${quote.makerQrlAccount}`);
  console.log(`maker eth    ${quote.makerEthAccount}`);
  console.log(
    `order proof  verified, expires ${new Date(quote.expiresAt * 1000).toISOString()}`,
  );
  console.log(
    `presence     ${quote.makerSeen === null ? "unknown" : quote.makerSeen ? "maker online" : "maker offline"}`,
  );
  console.log(`pre-funded   ${quote.prelocked ? "yes" : "no"}`);
  console.log(
    `timeouts     the maker sets them in FillV2. This client funds only when its escrow ` +
      `outlives ours by at least ${cfg.claimSafetyS}s, refuses to fund inside ${cfg.lockRunwayS}s ` +
      `of our own deadline, and verifies the escrow ${cfg.confirmations} block(s) behind the head.`,
  );
  if (quote.issue !== null) {
    console.log(`unavailable  ${quote.issue}`);
    return 1;
  }
  return 0;
}

async function commandTake(args: ParsedArgs): Promise<number> {
  const orderId = args.positional[0];
  if (orderId === undefined) throw new Error("take needs an order id");
  const dryRun = args.flags.has("dry-run");
  const cfg = loadTakerConfig();
  const session = await signingSession(cfg, { dryRun });
  try {
    const preview = await session.engine.quote(orderId);
    const bounds = boundsFor(args, preview);
    console.log(
      `Taking order ${orderId}: lock ${preview.pay.display}, receive ${preview.receive.display}.`,
    );
    if (preview.issue !== null) {
      throw new Error(`refusing to take this order: ${preview.issue}`);
    }
    if (!args.flags.has("yes") && !dryRun) {
      const confirmed = await confirm(
        "This escrows real testnet funds. Continue? [y/N] ",
      );
      if (!confirmed) {
        console.log("Cancelled; nothing was signed or sent.");
        return EXIT_UNFUNDED;
      }
    }
    // The consented terms are pinned by digest, so a book that swapped the
    // order under this id between the quote and the take is refused.
    const record = await session.engine.begin(
      orderId,
      bounds,
      preview.orderDigest,
    );
    const { outcome } = await session.engine.run(record, {
      ...(args.flags.has("once") || dryRun ? { maxPasses: 1 } : {}),
    });
    if (outcome === null) {
      console.log(
        "This take is still in flight. Run `taker status` to see where it stands and `taker resume` to continue it.",
      );
    }
    return takeExitCode(outcome);
  } finally {
    session.close();
  }
}

async function commandResume(args: ParsedArgs): Promise<number> {
  const cfg = loadTakerConfig();
  const session = await signingSession(cfg, {
    dryRun: args.flags.has("dry-run"),
  });
  try {
    const verdicts = await session.engine.resume({
      ...(args.flags.has("once") ? { once: true } : {}),
    });
    if (verdicts.length === 0) console.log("No in-flight takes to resume.");
    for (const verdict of verdicts) {
      console.log(`${verdict.decision}: ${verdict.reason}`);
    }
    return 0;
  } finally {
    session.close();
  }
}

async function commandStatus(args: ParsedArgs): Promise<number> {
  const cfg = loadTakerConfig();
  const session = await signingSession(cfg, {
    dryRun: true,
    verifyChains: false,
    readOnly: true,
  });
  try {
    const lines = session.engine.status();
    if (args.flags.has("json")) {
      console.log(
        JSON.stringify(
          { inFlight: lines, settled: session.engine.history() },
          jsonReplacer,
          2,
        ),
      );
      return 0;
    }
    const history = session.engine.history();
    if (lines.length === 0) {
      console.log(
        history.length === 0
          ? "No takes recorded yet."
          : "No takes in flight.",
      );
    }
    for (const line of lines) {
      console.log(
        [
          line.orderId.slice(0, 12),
          line.direction,
          `pay ${line.pay}`,
          `receive ${line.receive}`,
          line.phase,
          line.hashlock === null ? "" : `hashlock ${line.hashlock.slice(0, 10)}`,
          line.responderTimeout === null
            ? ""
            : `our deadline ${new Date(line.responderTimeout * 1000).toISOString()}`,
        ]
          .filter((part) => part !== "")
          .join("  "),
      );
    }
    if (history.length > 0) {
      console.log(`Settled (${history.length} kept):`);
      for (const entry of history) {
        console.log(
          [
            `  ${entry.orderId.slice(0, 12)}`,
            entry.outcome,
            `paid ${entry.paid}`,
            `received ${entry.received}`,
            new Date(entry.settledAt * 1000).toISOString(),
            entry.claimTx === null ? "" : `claim ${entry.claimTx}`,
            entry.refundTx === null ? "" : `refund ${entry.refundTx}`,
          ]
            .filter((part) => part !== "")
            .join("  "),
        );
      }
    }
    return 0;
  } finally {
    session.close();
  }
}

async function commandRelease(args: ParsedArgs): Promise<number> {
  const orderId = args.positional[0];
  if (orderId === undefined) throw new Error("release needs an order id");
  const cfg = loadTakerConfig();
  const session = await signingSession(cfg, {
    dryRun: args.flags.has("dry-run"),
  });
  try {
    const record = session.engine.record(orderId);
    if (record === null) {
      throw new Error(`no recorded take for order ${orderId}`);
    }
    if (record.lockSentAt !== null) {
      throw new Error(
        `order ${orderId} already has an escrow send behind it; the chain governs it now. Use resume to settle or refund it`,
      );
    }
    const { record: current, verdict } = await session.engine.step(record, {
      abandon: true,
    });
    console.log(`${verdict.decision}: ${verdict.reason}`);
    return current.outcome === null ? 1 : 0;
  } finally {
    session.close();
  }
}

/** bigint values are serialized as decimal strings so --json output stays
 *  exact and machine readable. */
function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

export async function confirm(prompt: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    throw new Error(
      "refusing to take without a confirmation: pass --yes for non-interactive runs",
    );
  }
  process.stdout.write(prompt);
  const answer = await new Promise<string>((resolve) => {
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", (chunk: string) => resolve(chunk.trim()));
  });
  process.stdin.pause();
  return answer.toLowerCase() === "y" || answer.toLowerCase() === "yes";
}

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.flags.has("help") || args.flags.has("h")) {
    console.log(USAGE);
    return 0;
  }
  switch (args.command) {
    case "list":
      return commandList(args);
    case "quote":
      return commandQuote(args);
    case "take":
      return commandTake(args);
    case "resume":
      return commandResume(args);
    case "status":
      return commandStatus(args);
    case "release":
      return commandRelease(args);
    case "help":
      console.log(USAGE);
      return 0;
    case "":
      console.log(USAGE);
      return 1;
    default:
      console.error(`unknown command "${args.command}"\n`);
      console.log(USAGE);
      return 1;
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(
        "taker failed:",
        error instanceof Error ? error.message : error,
      );
      process.exitCode = 1;
    });
}
