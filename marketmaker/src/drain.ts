import type { BookStatus } from "./policy.js";

/** Cancel only unfunded open exposure during an operator drain. Accepted
 *  and locking swaps must continue through the normal lifecycle. */
export async function cancelOpenListing(
  draining: boolean,
  status: BookStatus,
  cancel: () => Promise<unknown>,
  isAlreadyGone: (err: unknown) => boolean,
): Promise<boolean> {
  if (!draining || status !== "open") return false;
  try {
    await cancel();
  } catch (err) {
    if (!isAlreadyGone(err)) throw err;
  }
  return true;
}
