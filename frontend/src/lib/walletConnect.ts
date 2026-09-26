import type { EthereumProvider } from "@walletconnect/ethereum-provider";
import { ETH_LEG } from "@/config";

export type WalletConnectClient = InstanceType<typeof EthereumProvider>;

let clientPromise: Promise<WalletConnectClient> | undefined;
const STORAGE_KEY = "quantaswap:ethereum:walletconnect";

// Reown's modal lives in its own shadow DOM and takes plain color strings, so
// the two theme tokens it needs are resolved here from the QRL Blue palette in
// index.css: --primary (hsl(199 78% 55%)) and --card (hsl(222 38% 9%)).
const QRL_BLUE = { accent: "#33ade6", surface: "#0e1320" } as const;

// Public Reown project id of the official quantaswap.io deployment. It ships
// in every bundle by design; the Reown dashboard's domain allowlist is what
// restricts its use. A fork sets VITE_WALLETCONNECT_PROJECT_ID to its own
// project, or to "off" to hide the option.
const OFFICIAL_PROJECT_ID = "5ab9fe6bb5d5e4237b468f260b392e7a";

function walletConnectProjectId(): string | null {
  const configured = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID?.trim() ?? "";
  const id = configured === "" ? OFFICIAL_PROJECT_ID : configured;
  return /^[a-f\d]{32}$/i.test(id) ? id : null;
}

export function isWalletConnectConfigured(): boolean {
  return walletConnectProjectId() !== null;
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
  const projectId = walletConnectProjectId();
  if (projectId === null) {
    return Promise.reject(new Error("WalletConnect is unavailable. Choose another wallet."));
  }
  clientPromise ??= import("@walletconnect/ethereum-provider")
    .then(({ EthereumProvider }) =>
      EthereumProvider.init({
        projectId,
        chains: [Number(ETH_LEG.chainIdHex)],
        // Only what the ETH leg uses: HTLC lock, claim, refund and ERC-20
        // approve are all plain transactions. No message signing is requested.
        methods: ["eth_sendTransaction"],
        optionalMethods: ["wallet_switchEthereumChain"],
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
        // QRL Blue, matching the sibling <qrl-pairing-modal> on the QRL leg.
        // The provider maps these legacy names onto Reown AppKit variables:
        // accent-color drives --w3m-accent and the QR modules, background-color
        // drives --w3m-color-mix, and container-border-radius drives
        // --w3m-border-radius-master, the base unit AppKit multiplies per
        // component (3px keeps cards near the app's 12px radius).
        qrModalOptions: {
          themeMode: "dark",
          themeVariables: {
            "--wcm-font-family": '"Instrument Sans Variable", system-ui, sans-serif',
            "--wcm-accent-color": QRL_BLUE.accent,
            "--wcm-background-color": QRL_BLUE.surface,
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
