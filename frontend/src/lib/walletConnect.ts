import type { EthereumProvider } from "@walletconnect/ethereum-provider";
import { ETH_LEG } from "@/config";

export type WalletConnectClient = InstanceType<typeof EthereumProvider>;

let clientPromise: Promise<WalletConnectClient> | undefined;
const STORAGE_KEY = "quantaswap:ethereum:walletconnect";

export function isWalletConnectConfigured(): boolean {
  return /^[a-f\d]{32}$/i.test(import.meta.env.VITE_WALLETCONNECT_PROJECT_ID?.trim() ?? "");
}

export function rememberWalletConnect(remember: boolean): void {
  try {
    if (remember) localStorage.setItem(STORAGE_KEY, "selected");
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Connecting still works when browser storage is unavailable.
  }
}

export function shouldRestoreWalletConnect(): boolean {
  try {
    return isWalletConnectConfigured() && localStorage.getItem(STORAGE_KEY) === "selected";
  } catch {
    return false;
  }
}

// Load Reown's wallet directory and QR UI only when this transport is selected.
export function getWalletConnectClient(): Promise<WalletConnectClient> {
  if (!isWalletConnectConfigured()) {
    return Promise.reject(new Error("WalletConnect is unavailable. Choose another wallet."));
  }
  clientPromise ??= import("@walletconnect/ethereum-provider")
    .then(({ EthereumProvider }) =>
      EthereumProvider.init({
        projectId: import.meta.env.VITE_WALLETCONNECT_PROJECT_ID.trim(),
        chains: [Number(ETH_LEG.chainIdHex)],
        methods: ["eth_sendTransaction", "personal_sign"],
        optionalMethods: ["wallet_switchEthereumChain", "eth_signTypedData_v4"],
        rpcMap: {
          [Number(ETH_LEG.chainIdHex)]: new URL(ETH_LEG.rpc, window.location.origin).href,
        },
        metadata: {
          name: "QuantaSwap",
          description: "Atomic swaps between Ethereum and QRL",
          url: window.location.origin,
          icons: [new URL("/apple-touch-icon.png", window.location.origin).href],
        },
        telemetryEnabled: false,
        showQrModal: true,
        qrModalOptions: {
          themeMode: "dark",
          themeVariables: {
            "--wcm-font-family": '"Instrument Sans Variable", system-ui, sans-serif',
            "--wcm-accent-color": "#ddc9a6",
            "--wcm-background-color": "#0d0e11",
            "--wcm-container-border-radius": "3px",
            "--wcm-z-index": "1000",
          },
        },
      }),
    )
    .catch((error: unknown) => {
      clientPromise = undefined;
      throw error;
    });
  return clientPromise;
}
