import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BrowserProvider } from "ethers";
import { ETH_LEG } from "@/config";
import { getMetaMaskClient, type MetaMaskClient } from "@/lib/metaMask";
import { errorMessage, isUserRejection } from "@/utils/errorMessage";

export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
  on?(event: string, handler: (...args: unknown[]) => void): void;
  off?(event: string, handler: (...args: unknown[]) => void): void;
  removeListener?(event: string, handler: (...args: unknown[]) => void): void;
}

export interface ProviderDetail {
  info: { uuid: string; name: string; icon: string; rdns: string };
  provider: Eip1193Provider;
}

declare global {
  interface WindowEventMap {
    "eip6963:announceProvider": CustomEvent<ProviderDetail>;
  }
}

function firstAccount(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const account: unknown = value[0];
  return typeof account === "string" && /^0x[\da-f]{40}$/i.test(account) ? account : null;
}

export function useEthWallet() {
  const [announced, setAnnounced] = useState<ProviderDetail[]>([]);
  const [legacy, setLegacy] = useState<ProviderDetail | null>(null);
  const [selected, setSelected] = useState<ProviderDetail | null>(null);
  const [account, setAccount] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const generationRef = useRef(0);
  const busyRef = useRef(false);
  const pendingProvidersRef = useRef(new Set<Eip1193Provider>());
  const qrlProvidersRef = useRef(new Set<Eip1193Provider>());
  const activeRef = useRef<Eip1193Provider | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const metaMaskRef = useRef<MetaMaskClient | null>(null);

  useEffect(() => {
    const onAnnounce = (event: CustomEvent<ProviderDetail>) => {
      const detail = event.detail;
      if (!detail?.info || typeof detail.provider?.request !== "function") return;
      if (
        ![detail.info.uuid, detail.info.name, detail.info.rdns, detail.info.icon].every(
          (value) => typeof value === "string",
        )
      )
        return;
      if (/qrl/i.test(detail.info.rdns) || /qrl/i.test(detail.info.name)) {
        qrlProvidersRef.current.add(detail.provider);
        setLegacy((previous) => (previous?.provider === detail.provider ? null : previous));
        return;
      }
      setAnnounced((previous) =>
        previous.some(
          (wallet) => wallet.info.uuid === detail.info.uuid || wallet.provider === detail.provider,
        )
          ? previous
          : [...previous, detail],
      );
    };
    window.addEventListener("eip6963:announceProvider", onAnnounce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    return () => window.removeEventListener("eip6963:announceProvider", onAnnounce);
  }, []);

  const detach = useCallback(() => {
    activeRef.current = null;
    cleanupRef.current?.();
    cleanupRef.current = null;
  }, []);

  useEffect(
    () => () => {
      generationRef.current += 1;
      detach();
    },
    [detach],
  );

  const providers = useMemo(
    () => (announced.length ? announced : legacy ? [legacy] : []),
    [announced, legacy],
  );

  const openPicker = useCallback(() => {
    if (busyRef.current) return;
    setError(null);
    // Older extensions may expose only window.ethereum. Offer it as an
    // explicit choice after asking EIP-6963 wallets to announce again.
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    const provider = (window as Window & { ethereum?: Eip1193Provider }).ethereum;
    setLegacy(
      provider && typeof provider.request === "function" && !qrlProvidersRef.current.has(provider)
        ? {
            info: { uuid: "window.ethereum", name: "Browser wallet", icon: "", rdns: "" },
            provider,
          }
        : null,
    );
    setPickerOpen(true);
  }, []);

  const closePicker = useCallback(() => {
    generationRef.current += 1;
    setPickerOpen(false);
    setError(null);
    busyRef.current = false;
    setPendingId(null);
    // A canceled approval may still resolve inside the extension. Its
    // generation stays stale while the user chooses another wallet.
  }, []);

  const attach = useCallback(
    (detail: ProviderDetail, accounts: unknown) => {
      const next = firstAccount(accounts);
      if (!next)
        throw new Error("Your wallet did not share an Ethereum account. Try connecting again.");
      detach();
      activeRef.current = detail.provider;
      setSelected(detail);
      setAccount(next);
      setError(null);
      setPickerOpen(false);
      const onAccountsChanged = (value: unknown) => {
        if (activeRef.current !== detail.provider) return;
        const nextAccount = firstAccount(value);
        setAccount(nextAccount);
        setError(null);
        if (!nextAccount) {
          setSelected(null);
          detach();
        }
      };
      const onDisconnect = () => {
        if (activeRef.current !== detail.provider) return;
        generationRef.current += 1;
        detach();
        setSelected(null);
        setAccount(null);
        setError(null);
      };
      detail.provider.on?.("accountsChanged", onAccountsChanged);
      detail.provider.on?.("disconnect", onDisconnect);
      cleanupRef.current = () => {
        for (const [event, handler] of [
          ["accountsChanged", onAccountsChanged],
          ["disconnect", onDisconnect],
        ] as const) {
          if (detail.provider.removeListener) detail.provider.removeListener(event, handler);
          else detail.provider.off?.(event, handler);
        }
      };
    },
    [detach],
  );

  const connect = useCallback(
    async (choice: ProviderDetail) => {
      if (busyRef.current) return;
      if (pendingProvidersRef.current.has(choice.provider)) {
        setError("Complete or dismiss the existing connection request in this wallet, then retry.");
        return;
      }
      busyRef.current = true;
      pendingProvidersRef.current.add(choice.provider);
      const generation = ++generationRef.current;
      setPendingId(choice.info.uuid);
      setError(null);
      try {
        const accounts = await choice.provider.request({ method: "eth_requestAccounts" });
        if (generation === generationRef.current) attach(choice, accounts);
      } catch (cause) {
        if (generation === generationRef.current) {
          setError(
            isUserRejection(cause)
              ? "Connection declined. Choose a wallet to try again."
              : errorMessage(cause),
          );
        }
      } finally {
        pendingProvidersRef.current.delete(choice.provider);
        if (generation === generationRef.current) {
          busyRef.current = false;
          setPendingId(null);
        }
      }
    },
    [attach],
  );

  const connectMetaMask = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    const generation = ++generationRef.current;
    setPendingId("metamask-mobile");
    setPickerOpen(false);
    setError(null);
    try {
      const client = await getMetaMaskClient();
      metaMaskRef.current = client;
      if (generation !== generationRef.current) return;
      const { accounts } = await client.connect({
        chainIds: [ETH_LEG.chainIdHex as `0x${string}`],
      });
      if (generation !== generationRef.current) {
        await client.disconnect();
        return;
      }
      attach(
        {
          info: { uuid: "metamask-mobile", name: "MetaMask", icon: "", rdns: "io.metamask" },
          provider: client.getProvider(),
        },
        accounts,
      );
    } catch (cause) {
      if (generation === generationRef.current) {
        setError(
          isUserRejection(cause)
            ? "Connection declined. Choose a wallet to try again."
            : errorMessage(cause),
        );
        setPickerOpen(true);
      }
    } finally {
      busyRef.current = false;
      setPendingId(null);
    }
  }, [attach]);

  const disconnect = useCallback(async () => {
    generationRef.current += 1;
    const isMetaMask = selected?.info.uuid === "metamask-mobile";
    detach();
    setSelected(null);
    setAccount(null);
    setError(null);
    if (isMetaMask && metaMaskRef.current) {
      busyRef.current = true;
      setPendingId("metamask-mobile");
      try {
        await metaMaskRef.current.disconnect();
      } catch {
        setError(
          "The MetaMask session could not be closed. Disconnect QuantaSwap in MetaMask too.",
        );
      } finally {
        busyRef.current = false;
        setPendingId(null);
      }
    }
  }, [detach, selected]);

  const ensureSepolia = useCallback(async (): Promise<void> => {
    if (!selected || !account) throw new Error("Ethereum wallet not connected");
    const chainId = await selected.provider.request({ method: "eth_chainId" });
    if (typeof chainId === "string" && chainId.toLowerCase() === ETH_LEG.chainIdHex) return;
    try {
      await selected.provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: ETH_LEG.chainIdHex }],
      });
    } catch {
      throw new Error(
        `Switch your wallet to ${ETH_LEG.name} (chain ${ETH_LEG.chainIdHex}) and retry.`,
      );
    }
  }, [selected, account]);

  const browserProvider = useMemo(
    () => (selected && account ? new BrowserProvider(selected.provider) : null),
    [selected, account],
  );

  return {
    providers,
    account,
    connect,
    connectMetaMask,
    disconnect,
    ensureSepolia,
    browserProvider,
    walletName: selected?.info.name ?? null,
    error,
    pickerOpen,
    openPicker,
    closePicker,
    pendingId,
  };
}
