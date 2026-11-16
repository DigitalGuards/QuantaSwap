// Hashlocks of swaps created in this page session (a match, a take, a sandbox
// start). In memory only: a reload starts with an empty set, so opening a swap
// link never counts as fresh.

const fresh = new Set<string>();

const norm = (hashlock: string): string => hashlock.toLowerCase();

export const markFreshSwap = (hashlock: string | null | undefined): void => {
  if (hashlock !== null && hashlock !== undefined) fresh.add(norm(hashlock));
};

export const isFreshSwap = (hashlock: string): boolean => fresh.has(norm(hashlock));

export const forgetFreshSwap = (hashlock: string): void => {
  fresh.delete(norm(hashlock));
};
