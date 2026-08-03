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
  attemptWalletRedirect,
  getAppStoreUrl,
  type ConnectionStatus,
} from "@qrlwallet/connect";
import { getAuthorizedQrlAccount, requireQrlAccount } from "@/lib/qrlAddress";
import { errorMessage } from "@/utils/errorMessage";

export type QrlStatus = "disconnected" | "pairing" | "connected";
/** Which transport is active; drives the qrl_sendTransaction param shape. */
export type QrlTransport = "relay" | "extension";

// Injected QRL extensions: the upstream QRL Web3 Wallet and the MyQRLWallet
// Extension fork (minted 2026-07-09). Both speak the same provider API.
const QRL_EXTENSION_RDNS = new Set(["theqrl.org", "com.qrlwallet.extension"]);
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
  const wiredExtensionProvidersRef = useRef(new WeakSet<QrlProvider>());
  const kindRef = useRef<QrlTransport | null>(null);
  const userDisconnectedRef = useRef(false);
  const wasConnectedRef = useRef(false);
  const authorizationRef = useRef<Promise<void> | null>(null);
  const disconnectInFlightRef = useRef<Promise<unknown | null> | null>(null);
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

  /** Returns the retirement error, keeping UI state intact until confirmation. */
  const retireRelay = useCallback((): Promise<unknown | null> => {
    if (disconnectInFlightRef.current) return disconnectInFlightRef.current;
    userDisconnectedRef.current = true;

    const retirement = (async (): Promise<unknown | null> => {
      try {
        await sdk().disconnect();
        userDisconnectedRef.current = false;
        wasConnectedRef.current = false;
        setTransport(null);
        setStatus("disconnected");
        setStatusDetail("");
        setAccount(null);
        setUri(null);
        return null;
      } catch (err) {
        userDisconnectedRef.current = false;
        return err;
      }
    })();
    let tracked: Promise<unknown | null>;
    tracked = retirement.finally(() => {
      if (disconnectInFlightRef.current === tracked) disconnectInFlightRef.current = null;
    });
    disconnectInFlightRef.current = tracked;
    return tracked;
  }, [sdk, setTransport]);

  const authorizeRelay = useCallback(
    (qrl: QRLConnect): Promise<void> => {
      if (authorizationRef.current) return authorizationRef.current;
      const channelId = qrl.getChannelId();
      const authorization = (async () => {
        try {
          const next = await getAuthorizedQrlAccount(qrl);
          if (
            kindRef.current !== "relay" ||
            qrl.getChannelId() !== channelId ||
            userDisconnectedRef.current
          ) {
            return;
          }
          wasConnectedRef.current = true;
          setAccount(next);
          setStatus("connected");
          setUri(null);
          setError(null);
        } catch (err) {
          if (
            kindRef.current !== "relay" ||
            qrl.getChannelId() !== channelId ||
            userDisconnectedRef.current
          ) {
            return;
          }
          const authorizationError = errorMessage(err);
          const retirementError = await retireRelay();
          const message =
            retirementError === null
              ? `Could not authorize wallet account: ${authorizationError}`
              : `Could not authorize wallet account: ${authorizationError}. Could not retire pairing: ${errorMessage(retirementError)}`;
          setError(message);
          if (retirementError !== null) setStatusDetail(message);
        }
      })();
      let tracked: Promise<void>;
      tracked = authorization.finally(() => {
        if (authorizationRef.current === tracked) authorizationRef.current = null;
      });
      authorizationRef.current = tracked;
      return tracked;
    },
    [retireRelay],
  );

  // EIP-6963 discovery: surface only QRL-capable wallets (the QRL extension
  // and the relay SDK's own announcement); MetaMask-style providers cannot
  // sign QRL transactions and belong to the ETH leg picker.
  useEffect(() => {
    sdk(); // constructing the SDK makes it announce over EIP-6963
    const onAnnounce = (event: Event) => {
      const detail = (event as CustomEvent<Eip6963Detail>).detail;
      const info = detail?.info;
      if (!info?.uuid) return;
      if (info.rdns !== QRL_CONNECT_RDNS && !QRL_EXTENSION_RDNS.has(info.rdns)) return;
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
          `MyQRLWallet app not detected. Install it (${getAppStoreUrl()}) or use the copy-code option with the wallet at qrlwallet.com.`,
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
      if (kindRef.current === "extension" || userDisconnectedRef.current) return;
      setTransport("relay");
      if (qrl.getAccounts().length === 0) setStatus("pairing");
      void authorizeRelay(qrl);
    };
    const onAccounts = (accounts: unknown) => {
      if (kindRef.current === "extension" || userDisconnectedRef.current) return;
      if (Array.isArray(accounts) && accounts.length === 0) {
        void retireRelay().then((retirementError) => {
          if (retirementError !== null) {
            const message = `Could not retire pairing: ${errorMessage(retirementError)}`;
            setError(message);
            setStatusDetail(message);
          }
        });
        return;
      }
      try {
        const next = requireQrlAccount(accounts);
        setTransport("relay");
        wasConnectedRef.current = true;
        setAccount(next);
        setStatus("connected");
        setUri(null);
        setError(null);
      } catch (err) {
        void retireRelay().then((retirementError) => {
          const accountError = errorMessage(err);
          const message =
            retirementError === null
              ? accountError
              : `${accountError}. Could not retire pairing: ${errorMessage(retirementError)}`;
          setError(message);
          if (retirementError !== null) setStatusDetail(message);
        });
      }
    };
    const onStatus = (s: ConnectionStatus) => setStatusDetail(String(s));
    const onDisconnect = () => {
      if (kindRef.current === "extension") return;
      // The SDK also emits 'disconnect' when its reconnect probe gives up on
      // a wallet that is merely backgrounded (routine on mobile: the wallet
      // app loses its socket seconds after backgrounding). The stored
      // session survives that and any request revives it: relay-buffered
      // and, on mobile, deep-linked awake. Rotating to a fresh pairing here
      // would orphan the wallet side's session and could strand an approval
      // already in flight. Only a wallet-initiated terminate (stored
      // session gone) falls through to re-pair.
      if (!userDisconnectedRef.current && qrl.hasStoredSession()) {
        return;
      }
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
  }, [authorizeRelay, retireRelay, sdk, showPairing, setTransport]);

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
        const accounts = await detail.provider.request({
          method: "qrl_requestAccounts",
        });
        const first = requireQrlAccount(accounts);
        extensionRef.current = detail.provider;
        setTransport("extension");
        setAccount(first);
        setStatus("connected");
        setError(null);
        if (!wiredExtensionProvidersRef.current.has(detail.provider)) {
          wiredExtensionProvidersRef.current.add(detail.provider);
          detail.provider.on?.("accountsChanged", (accs) => {
            if (
              kindRef.current !== "extension" ||
              extensionRef.current !== detail.provider
            ) {
              return;
            }
            if (Array.isArray(accs) && accs.length === 0) {
              extensionRef.current = null;
              setTransport(null);
              setAccount(null);
              setStatus("disconnected");
              return;
            }
            try {
              setAccount(requireQrlAccount(accs));
            } catch (err) {
              extensionRef.current = null;
              setTransport(null);
              setAccount(null);
              setStatus("disconnected");
              setError(errorMessage(err));
            }
          });
        }
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

  const cancelPairing = useCallback(async () => {
    if (kindRef.current !== "relay") {
      setUri(null);
      setStatus("disconnected");
      return;
    }
    setError(null);
    setStatusDetail("cancelling...");
    const retirementError = await retireRelay();
    if (retirementError !== null) {
      const message = `Could not cancel pairing: ${errorMessage(retirementError)}`;
      setError(message);
      setStatusDetail(message);
    }
  }, [retireRelay]);

  const disconnect = useCallback(async () => {
    if (kindRef.current === "extension") {
      // No standard revoke call for injected providers; forget the local
      // selection, same convention as the ETH leg.
      extensionRef.current = null;
      userDisconnectedRef.current = false;
      wasConnectedRef.current = false;
      setTransport(null);
      setStatus("disconnected");
      setAccount(null);
      return;
    }
    if (kindRef.current !== "relay") {
      setTransport(null);
      setStatus("disconnected");
      setAccount(null);
      return;
    }
    setError(null);
    const retirementError = await retireRelay();
    if (retirementError !== null) {
      setError(`Could not disconnect wallet: ${errorMessage(retirementError)}`);
    }
  }, [retireRelay, setTransport]);

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
