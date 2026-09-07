import type { createEVMClient } from "@metamask/connect-evm";
import { ETH_LEG } from "@/config";

export type MetaMaskClient = Awaited<ReturnType<typeof createEVMClient>>;

let clientPromise: Promise<MetaMaskClient> | undefined;

// Load the mobile transport only after the user selects it in the wallet chooser.
export function getMetaMaskClient(): Promise<MetaMaskClient> {
  clientPromise ??= import("@metamask/connect-evm")
    .then(({ createEVMClient }) =>
      createEVMClient({
        dapp: {
          name: "QuantaSwap",
          url: window.location.origin,
          iconUrl: new URL("/apple-touch-icon.png", window.location.origin).href,
        },
        api: {
          supportedNetworks: {
            [ETH_LEG.chainIdHex]: new URL(ETH_LEG.rpc, window.location.origin).href,
          },
        },
        ui: { preferExtension: false },
        analytics: { enabled: false },
        skipAutoAnnounce: true,
      }),
    )
    .catch((error: unknown) => {
      clientPromise = undefined;
      throw error;
    });
  return clientPromise;
}
