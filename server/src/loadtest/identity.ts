// Synthetic ML-DSA-87 identities for the load harness. Key generation costs
// milliseconds per identity and the harness needs hundreds, so identities are
// derived from deterministic seeds and cached in the run directory. Every seed
// here is a fixed test constant and never authorizes anything on a real book.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { shake256 } from "@noble/hashes/sha3.js";
import {
  CryptoPublicKeyBytes,
  CryptoSecretKeyBytes,
  cryptoSignKeypair,
} from "@theqrl/mldsa87";

/** ML-DSA-87 descriptor: type 1, no options. Matches the wallet wire form. */
export const DESCRIPTOR_HEX = "0x010000";
const DESCRIPTOR_BYTES = new Uint8Array([1, 0, 0]);

export type Role = "maker" | "taker";

export interface Identity {
  role: Role;
  index: number;
  /** Deterministic 32-byte seed, hex without the 0x prefix. */
  seedHex: string;
  descriptor: string;
  publicKey: string;
  /** Lowercase QIP-55 account derived from descriptor plus public key. */
  qrlAccount: string;
  /** Synthetic Ethereum-leg account; never used on any chain. */
  ethAccount: string;
  /** Forwarded client address, from the documentation ranges in RFC 5737
   *  (IPv4) and RFC 3849 (IPv6). */
  ip: string;
}

interface IdentityCacheFile {
  version: 1;
  makers: Identity[];
  takers: Identity[];
}

export function identitySeed(role: Role, index: number): Uint8Array {
  return createHash("sha256")
    .update(`quantaswap-loadtest/${role}/${index}`)
    .digest();
}

/** RFC 5737 documentation addresses only, so nothing in the results or the
 *  tracked report can be mistaken for real infrastructure. */
function syntheticIp(role: Role, index: number): string {
  if (role === "maker") return `192.0.2.${(index % 254) + 1}`;
  const block = index < 254 ? "198.51.100" : "203.0.113";
  return `${block}.${(index % 254) + 1}`;
}

function deriveIdentity(role: Role, index: number): Identity {
  const seed = identitySeed(role, index);
  const publicKey = new Uint8Array(CryptoPublicKeyBytes);
  const secretKey = new Uint8Array(CryptoSecretKeyBytes);
  cryptoSignKeypair(seed, publicKey, secretKey);
  secretKey.fill(0);
  const bound = new Uint8Array(DESCRIPTOR_BYTES.length + publicKey.length);
  bound.set(DESCRIPTOR_BYTES);
  bound.set(publicKey, DESCRIPTOR_BYTES.length);
  const account = Buffer.from(shake256(bound, { dkLen: 64 })).toString("hex");
  const ethTail = Buffer.from(seed).toString("hex").slice(0, 40);
  return {
    role,
    index,
    seedHex: Buffer.from(seed).toString("hex"),
    descriptor: DESCRIPTOR_HEX,
    publicKey: `0x${Buffer.from(publicKey).toString("hex")}`,
    qrlAccount: `Q${account}`,
    ethAccount: `0x${ethTail}`,
    ip: syntheticIp(role, index),
  };
}

export interface IdentitySet {
  makers: Identity[];
  takers: Identity[];
  /** Wall-clock milliseconds spent deriving identities this run. */
  derivationMs: number;
  fromCache: boolean;
}

export function loadIdentities(
  cacheFile: string,
  makerCount: number,
  takerCount: number,
): IdentitySet {
  if (existsSync(cacheFile)) {
    const cached = readCache(cacheFile);
    if (
      cached !== undefined &&
      cached.makers.length >= makerCount &&
      cached.takers.length >= takerCount
    ) {
      return {
        makers: cached.makers.slice(0, makerCount),
        takers: cached.takers.slice(0, takerCount),
        derivationMs: 0,
        fromCache: true,
      };
    }
  }
  const startedAt = Date.now();
  const makers = Array.from({ length: makerCount }, (_value, index) =>
    deriveIdentity("maker", index),
  );
  const takers = Array.from({ length: takerCount }, (_value, index) =>
    deriveIdentity("taker", index),
  );
  const derivationMs = Date.now() - startedAt;
  const file: IdentityCacheFile = { version: 1, makers, takers };
  writeFileSync(cacheFile, JSON.stringify(file), { mode: 0o600 });
  return { makers, takers, derivationMs, fromCache: false };
}

function readCache(cacheFile: string): IdentityCacheFile | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(cacheFile, "utf8"));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as { version?: unknown }).version !== 1
    ) {
      return undefined;
    }
    const candidate = parsed as IdentityCacheFile;
    if (!Array.isArray(candidate.makers) || !Array.isArray(candidate.takers)) {
      return undefined;
    }
    return candidate;
  } catch {
    return undefined;
  }
}
