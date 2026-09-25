// A managed order is meaningful only on the exact pair of chains and
// HTLC deployments where it was created. Persist this identity beside
// every order so a config cutover cannot silently reinterpret old live
// state and re-lock the same hashlock on a replacement contract.

import { createHash } from "node:crypto";
import { canonicalQip55QrlAddress } from "./qip55.js";
import { protocolV2Config } from "./protocol-v2-config.js";

export interface DeploymentIdentity {
  schemaVersion: 2;
  ethChainId: string;
  qrlChainId: string;
  qrlGenesisHash: string;
  ethHtlc: string;
  qrlHtlc: string;
  configFingerprint: string;
}

export interface DeploymentConfig {
  ethChainId: string;
  qrlChainId: string;
  ethHtlc: string;
  qrlHtlc: string;
  qrlGenesisHash?: string;
}

const ETH_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const FINGERPRINT = /^sha256:[0-9a-f]{64}$/;

/** Canonical decimal chain ID. RPC results may be decimal or 0x-prefixed. */
export function canonicalChainId(value: string, label = "chain ID"): string {
  if (!/^(?:0x[0-9a-fA-F]+|[0-9]+)$/.test(value)) {
    throw new Error(`${label} must be a positive decimal or hexadecimal integer`);
  }
  const id = BigInt(value);
  if (id <= 0n) throw new Error(`${label} must be positive`);
  return id.toString(10);
}

function canonicalEthAddress(value: string): string {
  if (!ETH_ADDRESS.test(value)) {
    throw new Error("ETH HTLC must be a 0x-prefixed 20-byte address");
  }
  return value.toLowerCase();
}

function canonicalQrlAddress(value: string): string {
  return canonicalQip55QrlAddress(value);
}

function fingerprint(config: Omit<DeploymentIdentity, "schemaVersion" | "configFingerprint">): string {
  const encoded = [
    "quantaswap-marketmaker-deployment-v2",
    `ethChainId=${config.ethChainId}`,
    `qrlChainId=${config.qrlChainId}`,
    `qrlGenesisHash=${config.qrlGenesisHash}`,
    `ethHtlc=${config.ethHtlc}`,
    `qrlHtlc=${config.qrlHtlc}`,
  ].join("\n");
  return `sha256:${createHash("sha256").update(encoded).digest("hex")}`;
}

export function makeDeploymentIdentity(config: DeploymentConfig): DeploymentIdentity {
  const genesis = config.qrlGenesisHash ?? protocolV2Config.qrlGenesisHash;
  if (!/^0x[0-9a-f]{64}$/.test(genesis)) throw new Error("QRL genesis hash must be canonical");
  const normalized = {
    ethChainId: canonicalChainId(config.ethChainId, "ETH chain ID"),
    qrlChainId: canonicalChainId(config.qrlChainId, "QRL chain ID"),
    qrlGenesisHash: genesis,
    ethHtlc: canonicalEthAddress(config.ethHtlc),
    qrlHtlc: canonicalQrlAddress(config.qrlHtlc),
  };
  return {
    schemaVersion: 2,
    ...normalized,
    configFingerprint: fingerprint(normalized),
  };
}

export function parseDeploymentIdentity(value: unknown, label: string): DeploymentIdentity {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} is missing or malformed`);
  }
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 2 ||
    typeof record.ethChainId !== "string" ||
    typeof record.qrlChainId !== "string" ||
    typeof record.qrlGenesisHash !== "string" ||
    typeof record.ethHtlc !== "string" ||
    typeof record.qrlHtlc !== "string" ||
    typeof record.configFingerprint !== "string" ||
    !FINGERPRINT.test(record.configFingerprint)
  ) {
    throw new Error(`${label} is missing or malformed`);
  }
  const parsed = makeDeploymentIdentity({
    ethChainId: record.ethChainId,
    qrlChainId: record.qrlChainId,
    qrlGenesisHash: record.qrlGenesisHash,
    ethHtlc: record.ethHtlc,
    qrlHtlc: record.qrlHtlc,
  });
  if (
    parsed.ethChainId !== record.ethChainId ||
    parsed.qrlChainId !== record.qrlChainId ||
    parsed.qrlGenesisHash !== record.qrlGenesisHash ||
    parsed.ethHtlc !== record.ethHtlc ||
    parsed.qrlHtlc !== record.qrlHtlc ||
    parsed.configFingerprint !== record.configFingerprint
  ) {
    throw new Error(`${label} is not canonical or its config fingerprint is invalid`);
  }
  return parsed;
}

export function sameDeployment(a: DeploymentIdentity, b: DeploymentIdentity): boolean {
  return (
    a.schemaVersion === b.schemaVersion &&
    a.ethChainId === b.ethChainId &&
    a.qrlChainId === b.qrlChainId &&
    a.qrlGenesisHash === b.qrlGenesisHash &&
    a.ethHtlc === b.ethHtlc &&
    a.qrlHtlc === b.qrlHtlc &&
    a.configFingerprint === b.configFingerprint
  );
}

/** Compare canonical identities, including checksum-normalized QRL addresses. */
export function assertPortableDeployment(deployment: DeploymentIdentity): void {
  if (!sameDeployment(deployment, makeDeploymentIdentity(protocolV2Config))) {
    throw new Error("configured deployment does not match the portable protocol signing domain");
  }
}

/** Fail before balances, order-book calls, or any transaction if an RPC
 * endpoint is connected to a different chain than the persisted identity. */
export function assertRuntimeChainIds(
  deployment: DeploymentIdentity,
  ethRpcChainId: string,
  qrlRpcChainId: string,
): void {
  const actualEth = canonicalChainId(ethRpcChainId, "ETH RPC chain ID");
  const actualQrl = canonicalChainId(qrlRpcChainId, "QRL RPC chain ID");
  if (actualEth !== deployment.ethChainId || actualQrl !== deployment.qrlChainId) {
    throw new Error(
      `RPC chain mismatch: configured ETH/QRL ${deployment.ethChainId}/${deployment.qrlChainId}, ` +
        `received ${actualEth}/${actualQrl}; refusing to manage or create orders`,
    );
  }
}
