// Operator view of the parked HTLCv3 payout credits in a maker state file,
// and the one editing action that file needs: dismissing a courtesy push that
// can never land.
//
// It takes the same exclusive state lease the daemon does, so it refuses to run
// while the maker is running. That is deliberate: two writers on one state file
// is how a record gets lost, and every reason to dismiss an entry comes up
// while the maker is stopped anyway.
//
// Nothing here moves funds. Collecting a maker-owned credit is a wallet
// action against the HTLC; this command only reports it.

import { pathToFileURL } from "node:url";
import { EthLeg } from "./chains.js";
import { loadConfig } from "./config.js";
import { makeDeploymentIdentity } from "./deployment.js";
import { ProtocolSigner } from "./protocol-signing.js";
import { StateFile, StateProcessLease, type StrandedCredit } from "./state.js";

const USAGE = `QuantaSwap maker: parked payout credits

Usage:
  credits list
  credits dismiss <key>

A parked credit is a payout the HTLC refused often enough, over long enough,
that the maker stopped trying. The value stays in the contract.

  Owner "maker"        this maker's own payout. Collect it with
                       withdrawAll(token, to) from the credited account; the
                       entry clears itself within the hour once the balance
                       reads zero. A drain waits for these to reach zero.
  Owner "counterparty" a courtesy push to a taker's address that refused the
                       payout. Only that address can ever be paid, so if it can
                       never receive, nothing clears this. It never gates a
                       drain, and this is the entry "dismiss" forgets. The
                       taker can still collect it themselves at any time.

The maker must be stopped: this command takes the same exclusive state lease.
Configuration comes from the same MM_* environment as the daemon.`;

const line = (entry: StrandedCredit): string =>
  [
    StateFile.strandedKey(entry),
    `order ${entry.orderId.slice(0, 8)}`,
    `owner ${entry.owner}`,
    `amount ${entry.amount}`,
    `hashlock ${entry.hashlock.slice(0, 10)}`,
    `parked ${new Date(entry.parkedAt * 1000).toISOString()}`,
  ].join("  ");

export async function main(argv: readonly string[]): Promise<number> {
  const [command, key] = argv;
  if (command === undefined || command === "help" || command === "--help") {
    console.log(USAGE);
    return command === undefined ? 1 : 0;
  }
  if (command !== "list" && command !== "dismiss") {
    console.error(`unknown command "${command}"\n`);
    console.log(USAGE);
    return 1;
  }

  const cfg = loadConfig();
  const deployment = makeDeploymentIdentity(cfg);
  // The lease is bound to the operator accounts, so this refuses a state file
  // belonging to different keys as well as one a running maker holds.
  const eth = new EthLeg(cfg);
  const signer = new ProtocolSigner(cfg.qrlHexseed);
  const lease = StateProcessLease.acquire(cfg.stateFile, {
    deploymentFingerprint: deployment.configFingerprint,
    ethAccount: eth.address.toLowerCase(),
    qrlAccount: signer.address.toLowerCase(),
  });
  try {
    const state = new StateFile(cfg.stateFile, deployment);
    for (const warning of state.warnings)
      console.error(`state warning: ${warning}`);

    if (command === "list") {
      const own = state.ownStrandedCredits();
      const theirs = state.counterpartyStrandedCredits();
      console.log(
        `Owed to this maker (${own.length}), a drain waits for these:`,
      );
      for (const entry of own) console.log(`  ${line(entry)}`);
      console.log(
        `Owed to a counterparty (${theirs.length}), reported and never gating a drain:`,
      );
      for (const entry of theirs) console.log(`  ${line(entry)}`);
      if (own.length === 0 && theirs.length === 0) {
        console.log(
          "Nothing is parked: every settlement handed over its funds.",
        );
      }
      return 0;
    }

    if (key === undefined) {
      console.error("dismiss needs the key from `credits list`");
      return 1;
    }
    const dismissed = state.dismissCounterpartyCredit(key);
    if (dismissed === null) {
      const existing = state
        .strandedCredits()
        .find((entry) => StateFile.strandedKey(entry) === key);
      console.error(
        existing === undefined
          ? `no parked credit under key ${key}`
          : `${key} is owed to this maker, so it has to be collected. Use withdrawAll(token, to) from the credited account; the entry clears itself once the balance reads zero.`,
      );
      return 1;
    }
    // Say exactly what was forgotten: this is the only place a record of money
    // in the contract is removed on a human's say-so.
    console.log(`dismissed a counterparty payout credit: ${line(dismissed)}`);
    console.log(
      `The ${dismissed.amount} base units stay in the HTLC credit ledger for ${dismissed.account}, and that address can still collect them at any time. This maker will not mention it again.`,
    );
    return 0;
  } finally {
    lease.close();
    signer.close();
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
        "credits failed:",
        error instanceof Error ? error.message : error,
      );
      process.exitCode = 1;
    });
}
