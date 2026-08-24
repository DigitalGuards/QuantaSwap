// EIP-6963 wallet discovery + connection for the Ethereum leg.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BrowserProvider } from "ethers";
import { ETH_LEG } from "../config";
import { errorMessage } from "@/utils/errorMessage";

export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
  on?(event: string, handler: (...args: unknown[]) => void): void;
  off?(event: string, handler: (...args: unknown[]) => void): void;
  removeListener?(event: string, handler: (...args: unknown[]) => void): void;
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
  const activeProviderRef = useRef<Eip1193Provider | null>(null);
  const accountsListenerRef = useRef<{
    provider: Eip1193Provider;
    handler: (...args: unknown[]) => void;
  } | null>(null);
  const connectGenerationRef = useRef(0);
  const [providers, setProviders] = useState<ProviderDetail[]>([]);
  const [selected, setSelected] = useState<ProviderDetail | null>(null);
  const [account, setAccount] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const detachAccountsListener = useCallback(() => {
    const current = accountsListenerRef.current;
    accountsListenerRef.current = null;
    if (!current) return;
    if (current.provider.removeListener) {
      current.provider.removeListener("accountsChanged", current.handler);
      return;
    }
    current.provider.off?.("accountsChanged", current.handler);
  }, []);

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

  useEffect(
    () => () => {
      connectGenerationRef.current += 1;
      activeProviderRef.current = null;
      detachAccountsListener();
    },
    [detachAccountsListener]
  );

  const connect = useCallback(
    async (choice?: ProviderDetail) => {
      const generation = ++connectGenerationRef.current;
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
        if (generation !== connectGenerationRef.current) return;
        detachAccountsListener();
        activeProviderRef.current = detail.provider;
        setSelected(detail);
        setAccount(accounts[0] ?? null);
        setError(null);
        const onAccountsChanged = (accs: unknown) => {
          if (activeProviderRef.current !== detail.provider) return;
          const list = accs as string[];
          setAccount(list[0] ?? null);
          setError(null);
        };
        accountsListenerRef.current = {
          provider: detail.provider,
          handler: onAccountsChanged,
        };
        detail.provider.on?.("accountsChanged", onAccountsChanged);
      } catch (err) {
        if (generation === connectGenerationRef.current) {
          setError(errorMessage(err));
        }
      }
    },
    [detachAccountsListener, providers, selected]
  );

  const disconnect = useCallback(() => {
    // EIP-1193 has no standard "revoke" call the app can rely on; matches
    // QuantaPool's convention of forgetting the local selection so the UI
    // reflects disconnected, even though the extension itself stays paired.
    connectGenerationRef.current += 1;
    activeProviderRef.current = null;
    detachAccountsListener();
    setSelected(null);
    setAccount(null);
    setError(null);
  }, [detachAccountsListener]);

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
