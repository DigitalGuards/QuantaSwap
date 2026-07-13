/** Human-readable message from anything a wallet/provider can throw.
 *  Injected providers reject with plain objects ({ code, message, data }),
 *  sometimes nesting the real cause under data; ethers wraps them in an
 *  Error whose `message` embeds the whole payload (calldata and all).
 *  String() on a plain object renders "[object Object]". */

/** True for the one benign, expected failure: the user declined the
 *  wallet prompt. Uses only the unambiguous machine signals (ethers
 *  ACTION_REJECTED and EIP-1193 code 4001), which are set at signature
 *  time BEFORE any broadcast, so callers may safely treat it as
 *  "nothing happened on-chain". */
export function isUserRejection(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as {
    code?: unknown;
    info?: { error?: { code?: unknown } };
    cause?: { code?: unknown };
    data?: { cause?: unknown };
  };
  return (
    e.code === "ACTION_REJECTED" ||
    e.code === 4001 ||
    e.info?.error?.code === 4001 ||
    e.cause?.code === 4001
  );
}

// Provider rejections that do not carry a machine code but are still plainly
// a user decline (some relays/extensions only send a message). Used for
// friendlier DISPLAY only, never to decide that nothing broadcast.
const REJECT_TEXT = /user (rejected|denied)|denied .*signature|action[_ ]rejected|ethers-user-denied/i;

const MAX_LEN = 200;
const clip = (s: string): string => (s.length > MAX_LEN ? `${s.slice(0, MAX_LEN - 1)}…` : s);

export function errorMessage(err: unknown): string {
  if (isUserRejection(err)) return "Transaction rejected in your wallet.";
  if (typeof err === "object" && err !== null) {
    // ethers v6 errors carry a concise `shortMessage`; prefer it over the
    // verbose `message` that embeds the full request payload.
    const rec = err as {
      shortMessage?: unknown;
      message?: unknown;
      data?: { message?: unknown };
    };
    if (typeof rec.data?.message === "string" && rec.data.message) return clip(rec.data.message);
    if (typeof rec.shortMessage === "string" && rec.shortMessage) {
      return REJECT_TEXT.test(rec.shortMessage)
        ? "Transaction rejected in your wallet."
        : clip(rec.shortMessage);
    }
    if (typeof rec.message === "string" && rec.message) {
      return REJECT_TEXT.test(rec.message)
        ? "Transaction rejected in your wallet."
        : clip(rec.message);
    }
    try {
      return clip(JSON.stringify(err));
    } catch {
      return "Unknown wallet error";
    }
  }
  return clip(String(err));
}
