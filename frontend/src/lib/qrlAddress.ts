const QRL_ADDRESS_RE = /^Q[0-9a-fA-F]{40}$/;
const HEX_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export function isQrlAddress(value: unknown): value is string {
  return typeof value === "string" && QRL_ADDRESS_RE.test(value);
}

export function isHexAddress(value: unknown): value is string {
  return typeof value === "string" && HEX_ADDRESS_RE.test(value);
}

export function qToHex(address: string): string {
  if (isQrlAddress(address)) return `0x${address.slice(1)}`;
  if (isHexAddress(address)) return address;
  throw new Error("Expected a Q-prefixed or 0x-prefixed 20-byte address");
}

export function hexToQ(address: string): string {
  if (isHexAddress(address)) return `Q${address.slice(2)}`;
  if (isQrlAddress(address)) return address;
  throw new Error("Expected a Q-prefixed or 0x-prefixed 20-byte address");
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
