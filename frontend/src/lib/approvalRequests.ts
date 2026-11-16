// Counts the wallet requests that wait for the user, at the place they are
// sent. A request is open from the moment it goes to the wallet until the
// wallet answers (a hash, a signature, a rejection or an error), which is
// exactly the time a wallet prompt can sit unseen behind its toolbar icon.
// Reads, simulations and the wait for a receipt never count.

/** Methods a wallet answers only after the user has looked at a prompt. */
const APPROVAL_METHODS: ReadonlySet<string> = new Set([
  "eth_requestAccounts",
  "eth_sendTransaction",
  "eth_sign",
  "personal_sign",
  "eth_signTypedData",
  "eth_signTypedData_v3",
  "eth_signTypedData_v4",
  "wallet_requestPermissions",
  "wallet_switchEthereumChain",
  "wallet_addEthereumChain",
  "wallet_watchAsset",
  "qrl_requestAccounts",
  "qrl_sendTransaction",
  "qrl_signTransaction",
  "qrl_signMessage",
  "qrl_signTypedData",
  "wallet_switchQrlChain",
  "wallet_addQrlChain",
]);

export const isApprovalMethod = (method: string): boolean => APPROVAL_METHODS.has(method);

export interface ApprovalRequests {
  /** Runs one wallet request and counts it as open until it settles. */
  track<T>(run: () => Promise<T>): Promise<T>;
  /** True while at least one tracked request is open. */
  pending(): boolean;
  subscribe(listener: () => void): () => void;
}

export function createApprovalRequests(): ApprovalRequests {
  let open = 0;
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of listeners) listener();
  };
  return {
    async track<T>(run: () => Promise<T>): Promise<T> {
      open += 1;
      notify();
      try {
        return await run();
      } finally {
        open -= 1;
        notify();
      }
    },
    pending: () => open > 0,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

interface RequestArgs {
  method: string;
  params?: unknown[] | object;
}

export interface RequestProvider {
  request(args: RequestArgs): Promise<unknown>;
}

/** The provider's `request`, with its approval-bound calls counted. */
export function trackedProvider(
  provider: RequestProvider,
  approvals: ApprovalRequests,
): RequestProvider {
  return {
    request: (args) =>
      isApprovalMethod(args.method)
        ? approvals.track(() => provider.request(args))
        : provider.request(args),
  };
}
