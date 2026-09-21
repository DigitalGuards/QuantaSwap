import {
  canonicalQip55QrlAddress,
  isQip55QrlAddress,
  isQrvmAddress,
} from "./qip55";

const HEX_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const DISPLAYABLE_QRL_ADDRESS_RE = /^Q(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{128})$/;
const DISPLAY_SEGMENT_LENGTH = 8;

export function isQrlAddress(value: unknown): value is string {
  return isQip55QrlAddress(value);
}

export function isHexAddress(value: unknown): value is string {
  return typeof value === "string" && HEX_ADDRESS_RE.test(value);
}

/** Stable visual fingerprint for long QRL addresses. */
export function formatQrlAddressFingerprint(address: string): string {
  if (!DISPLAYABLE_QRL_ADDRESS_RE.test(address)) return address;

  const body = address.slice(1);
  if (body.length < DISPLAY_SEGMENT_LENGTH * 3) return address;

  const middleStart = Math.floor((body.length - DISPLAY_SEGMENT_LENGTH) / 2);
  return [
    `Q${body.slice(0, DISPLAY_SEGMENT_LENGTH)}`,
    body.slice(middleStart, middleStart + DISPLAY_SEGMENT_LENGTH),
    body.slice(-DISPLAY_SEGMENT_LENGTH),
  ].join("...");
}

export function qToHex(address: string): string {
  if (isQrlAddress(address)) return `0x${address.slice(1)}`;
  if (isQrvmAddress(address)) return address;
  if (isHexAddress(address)) return address;
  throw new Error(
    "Expected a Q-prefixed 64-byte, 0x-prefixed 64-byte, or Ethereum 20-byte address",
  );
}

export function hexToQ(address: string): string {
  if (isQrvmAddress(address)) {
    // Preserve the caller's case: canonicalQip55QrlAddress enforces the
    // QIP-55 case rule (uniform case or exact checksum). Lowercasing first
    // would launder an invalid-checksum mixed-case alias into acceptance.
    return canonicalQip55QrlAddress(`Q${address.slice(2)}`);
  }
  if (isQrlAddress(address)) return canonicalQip55QrlAddress(address);
  throw new Error("Expected a Q-prefixed or 0x-prefixed 64-byte address");
}

export function requireQrlAccount(accounts: unknown): string {
  if (
    !Array.isArray(accounts) ||
    accounts.length !== 1 ||
    !accounts.every(isQrlAddress)
  ) {
    throw new Error("Wallet returned an invalid QRL account");
  }
  return accounts[0] as string;
}

/** Preserve the wallet's exact authorized spelling after full identity validation. */
export function bindAuthorizedMessageSigner(
  request: { method: string; params?: unknown[] },
  account: string | null,
): { method: string; params?: unknown[] } {
  if (request.method !== "qrl_signMessage") return request;
  const signer = request.params?.[0];
  if (
    !isQrlAddress(account) ||
    !isQrlAddress(signer) ||
    signer.toLowerCase() !== account.toLowerCase()
  ) {
    throw new Error("Message signer does not match the authorized QRL account");
  }
  return { ...request, params: [account, ...request.params!.slice(1)] };
}

export interface QrlAccountProvider {
  getAccounts(): unknown;
  request(args: { method: "qrl_requestAccounts" }): Promise<unknown>;
}

/** Reconnects use the persisted authorized cache. Fresh pairings prompt once. */
export async function getAuthorizedQrlAccount(provider: QrlAccountProvider): Promise<string> {
  const cached = provider.getAccounts();
  if (!Array.isArray(cached)) throw new Error("Wallet returned an invalid QRL account cache");
  if (cached.length > 0) return requireQrlAccount(cached);
  return requireQrlAccount(await provider.request({ method: "qrl_requestAccounts" }));
}
