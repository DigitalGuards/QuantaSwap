// Command line entry point for the scripted taker: list, quote, take,
// resume, status and release. Key material is only loaded by the commands
// that sign or send, and no command ever prints a secret.

import { parseUnits } from "ethers";
import { pathToFileURL } from "node:url";
import { assetInfo, type AssetSymbol } from "./assets.js";
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
import { initiatorLeg, responderLeg } from "./taker-policy.js";
import { TakerEngine, type TakeBounds } from "./taker.js";
import { TakerStateFile } from "./taker-state.js";

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

Configuration comes from TAKER_* environment variables; see
../docs/TAKERS.md and .env.example. list and quote need no keys.`;

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

/** Decimals of the leg an amount limit applies to. --max-in bounds what we
 *  escrow (the responder leg); --min-out bounds what we receive. */
function legDecimals(leg: LegKey, asset: AssetSymbol): number {
  return leg === "qrl" ? 18 : assetInfo(asset).decimals;
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
  options: { dryRun?: boolean; verifyChains?: boolean } = {},
): Promise<SigningSession> {
  const dryRun = options.dryRun === true;
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
  const lease = StateProcessLease.acquire(cfg.stateFile, {
    deploymentFingerprint: deployment.configFingerprint,
    ethAccount: eth.address.toLowerCase(),
    qrlAccount: signer.address.toLowerCase(),
  });
  let state: TakerStateFile;
  try {
    state = new TakerStateFile(
      cfg.stateFile,
      deployment,
      () => lease.assertOwned(),
      { ethAccount: eth.address, qrlAccount: signer.address },
    );
  } catch (error) {
    lease.close();
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
      lease.close();
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
      lease.close();
    },
  };
}

function boundsFor(
  args: ParsedArgs,
  direction: "eth->qrl" | "qrl->eth",
  asset: AssetSymbol,
): TakeBounds {
  const payLeg = responderLeg(direction);
  const receiveLeg = initiatorLeg(direction);
  const maxIn = flagValue(args, "max-in");
  const minOut = flagValue(args, "min-out");
  return {
    ...(maxIn === null
      ? {}
      : { maxIn: parseUnits(maxIn, legDecimals(payLeg, asset)) }),
    ...(minOut === null
      ? {}
      : { minOut: parseUnits(minOut, legDecimals(receiveLeg, asset)) }),
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
  const quote = await engine.quote(
    orderId,
    boundsFor(args, preview.direction, preview.asset),
  );
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
    const bounds = boundsFor(args, preview.direction, preview.asset);
    console.log(
      `Taking order ${orderId}: lock ${preview.pay.display}, receive ${preview.receive.display}.`,
    );
    if (!args.flags.has("yes") && !dryRun) {
      const confirmed = await confirm(
        "This escrows real testnet funds. Continue? [y/N] ",
      );
      if (!confirmed) {
        console.log("Cancelled; nothing was signed or sent.");
        return 1;
      }
    }
    const record = await session.engine.begin(orderId, bounds);
    const { outcome } = await session.engine.run(record, {
      ...(args.flags.has("once") || dryRun ? { maxPasses: 1 } : {}),
    });
    if (outcome === "claimed") return 0;
    if (outcome === null) return 0;
    return outcome === "uneven" ? 2 : 1;
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
      ...(args.flags.has("once") ? { maxPasses: 1 } : {}),
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
  });
  try {
    const lines = session.engine.status();
    if (args.flags.has("json")) {
      console.log(JSON.stringify(lines, jsonReplacer, 2));
      return 0;
    }
    if (lines.length === 0) console.log("No recorded takes.");
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

async function confirm(prompt: string): Promise<boolean> {
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
