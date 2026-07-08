// EIP-6963 wallet discovery + connection for the Ethereum leg.

import { useCallback, useEffect, useMemo, useState } from "react";
import { BrowserProvider } from "ethers";
import { ETH_LEG } from "../config";

export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
  on?(event: string, handler: (...args: unknown[]) => void): void;
}

interface ProviderDetail {
  info: { uuid: string; name: string; icon: string; rdns: string };
  provider: Eip1193Provider;
}

declare global {
  interface WindowEventMap {
    "eip6963:announceProvider": CustomEvent<ProviderDetail>;
  }
}

export function useEthWallet() {
  const [providers, setProviders] = useState<ProviderDetail[]>([]);
  const [selected, setSelected] = useState<ProviderDetail | null>(null);
  const [account, setAccount] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onAnnounce = (event: CustomEvent<ProviderDetail>) => {
      const detail = event.detail;
      // The QRL extension and the connect SDK also announce via EIP-6963;
      // they are the QRL leg, not the Ethereum leg.
      if (/qrl/i.test(detail.info.rdns) || /qrl/i.test(detail.info.name)) return;
      setProviders((prev) =>
        prev.some((p) => p.info.uuid === detail.info.uuid) ? prev : [...prev, detail]
      );
    };
    window.addEventListener("eip6963:announceProvider", onAnnounce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    return () => window.removeEventListener("eip6963:announceProvider", onAnnounce);
  }, []);

  const connect = useCallback(
    async (choice?: ProviderDetail) => {
      setError(null);
      const detail =
        choice ??
        selected ??
        providers[0] ??
        (typeof window !== "undefined" && (window as { ethereum?: Eip1193Provider }).ethereum
          ? {
              info: { uuid: "window", name: "Browser wallet", icon: "", rdns: "window.ethereum" },
              provider: (window as unknown as { ethereum: Eip1193Provider }).ethereum,
            }
          : null);
      if (!detail) {
        setError("No Ethereum wallet found. Install MetaMask or another EIP-6963 wallet.");
        return;
      }
      try {
        const accounts = (await detail.provider.request({
          method: "eth_requestAccounts",
        })) as string[];
        setSelected(detail);
        setAccount(accounts[0] ?? null);
        detail.provider.on?.("accountsChanged", (accs) => {
          const list = accs as string[];
          setAccount(list[0] ?? null);
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : "Wallet connection rejected");
      }
    },
    [providers, selected]
  );

  const disconnect = useCallback(() => {
    // EIP-1193 has no standard "revoke" call the app can rely on; matches
    // QuantaPool's convention of forgetting the local selection so the UI
    // reflects disconnected, even though the extension itself stays paired.
    setSelected(null);
    setAccount(null);
    setError(null);
  }, []);

  const ensureSepolia = useCallback(async (): Promise<void> => {
    if (!selected) throw new Error("Ethereum wallet not connected");
    const chainId = (await selected.provider.request({ method: "eth_chainId" })) as string;
    if (chainId.toLowerCase() === ETH_LEG.chainIdHex) return;
    try {
      await selected.provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: ETH_LEG.chainIdHex }],
      });
    } catch {
      throw new Error(`Switch your wallet to ${ETH_LEG.name} (chain ${ETH_LEG.chainIdHex}) and retry.`);
    }
  }, [selected]);

  const browserProvider = useMemo(
    () => (selected ? new BrowserProvider(selected.provider as never) : null),
    [selected]
  );

  return {
    providers,
    account,
    connect,
    disconnect,
    ensureSepolia,
    browserProvider,
    walletName: selected?.info.name ?? null,
    error,
  };
}
