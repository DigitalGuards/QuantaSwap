import {
  chmodSync,
  lstatSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { MLDSA87 } from "@theqrl/wallet.js";
import { Wallet } from "ethers";

export interface OperatorKeys {
  ethPrivateKey: string;
  ethAddress: string;
  qrlHexseed: string;
  qrlAddress: string;
}

export interface SecretPaths {
  ethPrivateKey: string;
  qrlHexseed: string;
}

function existing(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export function generateOperatorKeys(): OperatorKeys {
  const eth = Wallet.createRandom();
  const qrl = MLDSA87.newWallet();
  try {
    return {
      ethPrivateKey: eth.privateKey,
      ethAddress: eth.address,
      qrlHexseed: qrl.getHexExtendedSeed(),
      qrlAddress: qrl.getAddressStr(),
    };
  } finally {
    // wallet.js 2.0.2 implements zeroize(), but its generated declaration
    // omits the method. Keep the runtime cleanup while the upstream type
    // definition catches up.
    (qrl as typeof qrl & { zeroize(): void }).zeroize();
  }
}

/** Write both secrets with exclusive creation. If either target exists or
 *  a write fails, no newly created half-pair is left behind. */
export function writeOperatorSecrets(directory: string, keys: OperatorKeys): SecretPaths {
  if (!/^0x[0-9a-fA-F]{64}$/.test(keys.ethPrivateKey)) {
    throw new Error("generated Ethereum private key has an unexpected format");
  }
  if (!/^0x[0-9a-fA-F]{102}$/.test(keys.qrlHexseed)) {
    throw new Error("generated QRL extended seed has an unexpected format");
  }

  const dir = resolve(directory);
  const stat = existing(dir);
  if (stat !== null && (!stat.isDirectory() || stat.isSymbolicLink())) {
    throw new Error(`secret path ${dir} exists but is not a real directory`);
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);

  const paths: SecretPaths = {
    ethPrivateKey: join(dir, "eth-private-key"),
    qrlHexseed: join(dir, "qrl-hexseed"),
  };
  const created: string[] = [];
  try {
    for (const [path, value] of [
      [paths.ethPrivateKey, keys.ethPrivateKey],
      [paths.qrlHexseed, keys.qrlHexseed],
    ] as const) {
      writeFileSync(path, `${value}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      created.push(path);
      chmodSync(path, 0o600);
    }
  } catch (err) {
    for (const path of created) rmSync(path, { force: true });
    throw err;
  }
  return paths;
}

async function main(): Promise<void> {
  const directory = process.argv[2] ?? "./secrets";
  const keys = generateOperatorKeys();
  const paths = writeOperatorSecrets(directory, keys);
  console.log("Generated independent testnet LP wallets. Secret values were not printed.");
  console.log(`Ethereum address: ${keys.ethAddress}`);
  console.log(`QRL address: ${keys.qrlAddress}`);
  console.log(`Ethereum key file: ${paths.ethPrivateKey}`);
  console.log(`QRL seed file: ${paths.qrlHexseed}`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("Key initialization failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
