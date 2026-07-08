// Crypto fence: all secret material for swaps is generated and hashed here,
// exclusively via WebCrypto. The preimage never leaves the browser except
// inside a claim() transaction the user explicitly signs.

const toHex = (bytes: Uint8Array): string =>
  `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;

export interface SwapSecret {
  /** 32 random bytes, hex. Revealed on-chain at claim time. */
  preimage: string;
  /** sha256(preimage), hex. Shared across both legs. */
  hashlock: string;
}

export async function generateSecret(): Promise<SwapSecret> {
  const raw = new Uint8Array(32);
  crypto.getRandomValues(raw);
  const digest = await crypto.subtle.digest("SHA-256", raw.buffer as ArrayBuffer);
  return { preimage: toHex(raw), hashlock: toHex(new Uint8Array(digest)) };
}
