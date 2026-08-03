// A managed order is meaningful only on the exact pair of chains and
// HTLC deployments where it was created. Persist this identity beside
// every order so a config cutover cannot silently reinterpret old live
// state and re-lock the same hashlock on a replacement contract.

import { createHash } from "node:crypto";

export interface DeploymentIdentity {
  schemaVersion: 1;
  ethChainId: string;
  qrlChainId: string;
  ethHtlc: string;
  qrlHtlc: string;
  configFingerprint: string;
}

export interface DeploymentConfig {
  ethChainId: string;
  qrlChainId: string;
  ethHtlc: string;
  qrlHtlc: string;
}

const ETH_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const QRL_ADDRESS = /^Q[0-9a-fA-F]{40}$/;
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
  if (!QRL_ADDRESS.test(value)) {
    throw new Error("QRL HTLC must be a Q-prefixed 20-byte address");
  }
  return `Q${value.slice(1).toLowerCase()}`;
}

function fingerprint(config: Omit<DeploymentIdentity, "schemaVersion" | "configFingerprint">): string {
  const encoded = [
    "quantaswap-marketmaker-deployment-v1",
    `ethChainId=${config.ethChainId}`,
    `qrlChainId=${config.qrlChainId}`,
    `ethHtlc=${config.ethHtlc}`,
    `qrlHtlc=${config.qrlHtlc}`,
  ].join("\n");
  return `sha256:${createHash("sha256").update(encoded).digest("hex")}`;
}

export function makeDeploymentIdentity(config: DeploymentConfig): DeploymentIdentity {
  const normalized = {
    ethChainId: canonicalChainId(config.ethChainId, "ETH chain ID"),
    qrlChainId: canonicalChainId(config.qrlChainId, "QRL chain ID"),
    ethHtlc: canonicalEthAddress(config.ethHtlc),
    qrlHtlc: canonicalQrlAddress(config.qrlHtlc),
  };
  return {
    schemaVersion: 1,
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
    record.schemaVersion !== 1 ||
    typeof record.ethChainId !== "string" ||
    typeof record.qrlChainId !== "string" ||
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
    ethHtlc: record.ethHtlc,
    qrlHtlc: record.qrlHtlc,
  });
  if (
    parsed.ethChainId !== record.ethChainId ||
    parsed.qrlChainId !== record.qrlChainId ||
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
    a.ethHtlc === b.ethHtlc &&
    a.qrlHtlc === b.qrlHtlc &&
    a.configFingerprint === b.configFingerprint
  );
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
