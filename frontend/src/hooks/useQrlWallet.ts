// QRL leg wallet with an EIP-6963 picker across the two QRL-capable
// transports: the QRL browser extension (injected provider) and MyQRLWallet
// via @qrlwallet/connect (post-quantum encrypted relay, QR pairing).
// Relay pairing UX mirrors the reference dApp example
// (zondscan.com/dapp-example): getConnectionURI() for first connect +
// auto-reconnect, newConnection() only as an explicit reset, mobile
// qrlconnect:// deep link, QR auto-regeneration on wallet-initiated
// disconnect. Picker pattern ported from QuantaPool.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  QRLConnect,
  QRL_CONNECT_PROVIDER_INFO,
  type ConnectionStatus,
} from "@qrlwallet/connect";
import { errorMessage } from "@/utils/errorMessage";
import { appStoreUrl, attemptWalletRedirect } from "@/utils/deeplink";

export type QrlStatus = "disconnected" | "pairing" | "connected";
/** Which transport is active; drives the qrl_sendTransaction param shape. */
export type QrlTransport = "relay" | "extension";

const QRL_EXTENSION_RDNS = "theqrl.org";
const QRL_CONNECT_RDNS = QRL_CONNECT_PROVIDER_INFO.rdns;

export interface QrlProvider {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
  on?(event: string, handler: (...args: unknown[]) => void): void;
}

interface Eip6963Detail {
  info: { uuid: string; name: string; icon: string; rdns: string };
  provider: QrlProvider;
}

export interface DiscoveredQrlWallet {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
  kind: QrlTransport;
}

export function useQrlWallet() {
  const sdkRef = useRef<QRLConnect | null>(null);
  const detailMapRef = useRef(new Map<string, Eip6963Detail>());
  const extensionRef = useRef<QrlProvider | null>(null);
  const kindRef = useRef<QrlTransport | null>(null);
  const userDisconnectedRef = useRef(false);
  const wasConnectedRef = useRef(false);
  const [wallets, setWallets] = useState<DiscoveredQrlWallet[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [kind, setKind] = useState<QrlTransport | null>(null);
  const [status, setStatus] = useState<QrlStatus>("disconnected");
  const [statusDetail, setStatusDetail] = useState<string>("");
  const [account, setAccount] = useState<string | null>(null);
  const [uri, setUri] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const setTransport = useCallback((next: QrlTransport | null) => {
    kindRef.current = next;
    setKind(next);
  }, []);

  const sdk = useCallback((): QRLConnect => {
    if (!sdkRef.current) {
      sdkRef.current = new QRLConnect({
        dappMetadata: {
          name: "QuantaSwap",
          url: location.origin,
          // Peer redirect: after approving on mobile the wallet bounces the
          // user back here instead of stranding them in the wallet app.
          redirectUrl: location.href,
        },
        autoReconnect: true,
      });
    }
    return sdkRef.current;
  }, []);

  // EIP-6963 discovery: surface only QRL-capable wallets (the QRL extension
  // and the relay SDK's own announcement); MetaMask-style providers cannot
  // sign QRL transactions and belong to the ETH leg picker.
  useEffect(() => {
    sdk(); // constructing the SDK makes it announce over EIP-6963
    const onAnnounce = (event: Event) => {
      const detail = (event as CustomEvent<Eip6963Detail>).detail;
      const info = detail?.info;
      if (!info?.uuid) return;
      if (info.rdns !== QRL_CONNECT_RDNS && info.rdns !== QRL_EXTENSION_RDNS) return;
      if (detailMapRef.current.has(info.uuid)) return;
      detailMapRef.current.set(info.uuid, detail);
      setWallets(
        Array.from(detailMapRef.current.values()).map((d) => ({
          uuid: d.info.uuid,
          name: d.info.name,
          icon: d.info.icon,
          rdns: d.info.rdns,
          kind: d.info.rdns === QRL_CONNECT_RDNS ? "relay" : "extension",
        })),
      );
    };
    window.addEventListener("eip6963:announceProvider", onAnnounce);
    // Spec: dispatch AFTER listening so wallets that announced early re-announce.
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    return () => window.removeEventListener("eip6963:announceProvider", onAnnounce);
  }, [sdk]);

  const showPairing = useCallback(
    async (fresh: boolean) => {
      setError(null);
      setTransport("relay");
      const qrl = sdk();
      const connectionUri = fresh ? await qrl.newConnection() : await qrl.getConnectionURI();
      if (qrl.isMobile()) {
        // Deep-link into the app; if nothing handles the protocol (app not
        // installed, or chooser dismissed) fall back to the pairing modal
        // with copy-code plus an install pointer instead of dead-ending.
        const opened = await attemptWalletRedirect(connectionUri);
        if (opened) return;
        setError(
          `MyQRLWallet app not detected. Install it (${appStoreUrl()}) or use the copy-code option with the wallet at qrlwallet.com.`,
        );
      }
      setUri(connectionUri);
      setStatus("pairing");
    },
    [sdk, setTransport],
  );

  // Relay session events. Ignored while the extension transport is active so
  // a stale relay session cannot clobber an extension connection.
  useEffect(() => {
    const qrl = sdk();
    const onConnect = () => {
      if (kindRef.current === "extension") return;
      setTransport("relay");
      wasConnectedRef.current = true;
      userDisconnectedRef.current = false;
      setStatus("connected");
      setUri(null);
      void qrl
        .request({ method: "qrl_requestAccounts" })
        .then((accounts) => {
          const list = accounts as string[];
          setAccount(list[0] ?? null);
        })
        .catch(() => setAccount(null));
    };
    const onAccounts = (accounts: string[]) => {
      if (kindRef.current === "extension") return;
      setAccount(accounts[0] ?? null);
    };
    const onStatus = (s: ConnectionStatus) => setStatusDetail(String(s));
    const onDisconnect = () => {
      if (kindRef.current === "extension") return;
      setStatus("disconnected");
      setAccount(null);
      // Wallet-initiated disconnect: regenerate the QR so the user can
      // re-pair immediately (reference-example behavior).
      if (wasConnectedRef.current && !userDisconnectedRef.current) {
        wasConnectedRef.current = false;
        void showPairing(false).catch(() => undefined);
      }
    };
    qrl.on("connect", onConnect);
    qrl.on("accountsChanged", onAccounts);
    qrl.on("statusChanged", onStatus);
    qrl.on("disconnect", onDisconnect);
    if (qrl.isConnected()) onConnect();
    return () => {
      qrl.off("connect", onConnect);
      qrl.off("accountsChanged", onAccounts);
      qrl.off("statusChanged", onStatus);
      qrl.off("disconnect", onDisconnect);
    };
  }, [sdk, showPairing, setTransport]);

  /** Header button: open the wallet picker (re-poll announcements first). */
  const connect = useCallback(() => {
    setError(null);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    setPickerOpen(true);
  }, []);

  const closePicker = useCallback(() => setPickerOpen(false), []);

  /** Connect the wallet the user clicked in the picker. */
  const connectWallet = useCallback(
    async (uuid: string) => {
      const detail = detailMapRef.current.get(uuid);
      if (!detail) return;
      setPickerOpen(false);
      if (detail.info.rdns === QRL_CONNECT_RDNS) {
        try {
          await showPairing(false);
        } catch (err) {
          setError(err instanceof Error ? err.message : "Could not start pairing");
          setStatus("disconnected");
          setTransport(null);
        }
        return;
      }
      try {
        const accounts = (await detail.provider.request({
          method: "qrl_requestAccounts",
        })) as string[];
        const first = accounts[0];
        if (!first) throw new Error("The extension returned no accounts");
        extensionRef.current = detail.provider;
        setTransport("extension");
        setAccount(first);
        setStatus("connected");
        detail.provider.on?.("accountsChanged", (accs) => {
          if (kindRef.current !== "extension") return;
          const list = accs as string[];
          setAccount(list[0] ?? null);
        });
      } catch (err) {
        setError(errorMessage(err));
      }
    },
    [showPairing, setTransport],
  );

  // Explicit reset: tears down the existing relay pairing and rotates
  // channel/keys. Relay-only concept.
  const newConnection = useCallback(async () => {
    try {
      await showPairing(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create a new connection");
    }
  }, [showPairing]);

  const cancelPairing = useCallback(() => {
    setUri(null);
    if (status === "pairing") setStatus("disconnected");
  }, [status]);

  const disconnect = useCallback(async () => {
    userDisconnectedRef.current = true;
    wasConnectedRef.current = false;
    if (kindRef.current === "extension") {
      // No standard revoke call for injected providers; forget the local
      // selection, same convention as the ETH leg.
      extensionRef.current = null;
    } else {
      await sdk().disconnect();
    }
    setTransport(null);
    setStatus("disconnected");
    setAccount(null);
  }, [sdk, setTransport]);

  const request = useCallback(
    (args: { method: string; params?: unknown[] }) => {
      if (kindRef.current === "extension") {
        const provider = extensionRef.current;
        if (!provider) throw new Error("QRL extension not connected");
        return provider.request(args);
      }
      return sdk().request(args as never);
    },
    [sdk],
  );

  return {
    status,
    statusDetail,
    account,
    uri,
    error,
    wallets,
    pickerOpen,
    kind,
    connect,
    closePicker,
    connectWallet,
    newConnection,
    cancelPairing,
    disconnect,
    request,
  };
}
