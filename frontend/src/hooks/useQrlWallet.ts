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
import {
  activateExtensionAfterRelayRetirement,
  ChannelTaskGuard,
  ConnectionAttemptGuard,
  RelayResetGuard,
  shouldIgnoreRelayResetEvent,
} from "@/lib/relayReset";
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
  const authorizationGuardRef = useRef(new ChannelTaskGuard());
  const disconnectInFlightRef = useRef<Promise<unknown | null> | null>(null);
  const relayResetGuardRef = useRef(new RelayResetGuard());
  const connectionAttemptGuardRef = useRef(new ConnectionAttemptGuard());
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
        extensionRef.current = null;
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
      const channelId = qrl.getChannelId();
      return authorizationGuardRef.current.run(channelId, async () => {
        try {
          const next = await getAuthorizedQrlAccount(qrl);
          if (
            kindRef.current !== "relay" ||
            qrl.getChannelId() !== channelId ||
            userDisconnectedRef.current ||
            relayResetGuardRef.current.active ||
            connectionAttemptGuardRef.current.isPending("extension")
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
            userDisconnectedRef.current ||
            relayResetGuardRef.current.active ||
            connectionAttemptGuardRef.current.isPending("extension")
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
      });
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
    async (fresh: boolean, attemptGeneration?: number) => {
      const attemptIsCurrent = () =>
        attemptGeneration === undefined ||
        connectionAttemptGuardRef.current.isCurrent(attemptGeneration);
      if (!attemptIsCurrent() || relayResetGuardRef.current.active) return;
      setError(null);
      const qrl = sdk();
      const previousChannelId = qrl.getChannelId();
      const resetGeneration = relayResetGuardRef.current.begin();
      setStatusDetail(fresh ? "rotating connection..." : "preparing connection...");
      let connectionUri: string;
      try {
        connectionUri = fresh ? await qrl.newConnection() : await qrl.getConnectionURI();
        if (
          !attemptIsCurrent() ||
          !relayResetGuardRef.current.isCurrent(resetGeneration)
        ) {
          return;
        }
        extensionRef.current = null;
        setTransport("relay");
        userDisconnectedRef.current = false;
        wasConnectedRef.current = false;
        setAccount(null);
        setUri(null);
      } catch (err) {
        if (
          attemptIsCurrent() &&
          relayResetGuardRef.current.isCurrent(resetGeneration) &&
          qrl.getChannelId() !== previousChannelId &&
          kindRef.current !== "extension"
        ) {
          wasConnectedRef.current = false;
          setTransport(null);
          setAccount(null);
          setStatus("disconnected");
          setUri(null);
        }
        throw err;
      } finally {
        relayResetGuardRef.current.finish(resetGeneration);
      }

      if (!attemptIsCurrent()) return;
      setUri(connectionUri);
      setStatus("pairing");
      setStatusDetail(String(qrl.getStatus()));
      if (qrl.isMobile()) {
        // Deep-link into the app; if nothing handles the protocol (app not
        // installed, or chooser dismissed) fall back to the pairing modal
        // with copy-code plus an install pointer instead of dead-ending.
        const opened = await attemptWalletRedirect(connectionUri).catch(() => false);
        if (opened) return;
        setError(
          `MyQRLWallet app not detected. Install it (${getAppStoreUrl()}) or use the copy-code option with the wallet at qrlwallet.com.`,
        );
      }
    },
    [sdk, setTransport],
  );

  // Relay session events. Ignored while the extension transport is active so
  // a stale relay session cannot clobber an extension connection.
  useEffect(() => {
    const qrl = sdk();
    const onConnect = () => {
      if (
        kindRef.current === "extension" ||
        userDisconnectedRef.current ||
        relayResetGuardRef.current.active ||
        connectionAttemptGuardRef.current.isPending("extension")
      ) {
        return;
      }
      setTransport("relay");
      if (qrl.getAccounts().length === 0) setStatus("pairing");
      void authorizeRelay(qrl);
    };
    const onAccounts = (accounts: unknown) => {
      if (kindRef.current === "extension" || userDisconnectedRef.current) return;
      if (connectionAttemptGuardRef.current.isPending("extension")) return;
      if (shouldIgnoreRelayResetEvent(relayResetGuardRef.current, "accounts")) return;
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
    const onStatus = (s: ConnectionStatus) => {
      if (connectionAttemptGuardRef.current.isPending("extension")) return;
      if (shouldIgnoreRelayResetEvent(relayResetGuardRef.current, "status")) return;
      setStatusDetail(String(s));
    };
    const onDisconnect = () => {
      if (kindRef.current === "extension") return;
      if (connectionAttemptGuardRef.current.isPending("extension")) return;
      if (shouldIgnoreRelayResetEvent(relayResetGuardRef.current, "disconnect")) return;
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
        void showPairing(false).catch(async (err) => {
          const retirementError = await retireRelay();
          const pairingError = errorMessage(err);
          const message =
            retirementError === null
              ? `Could not create replacement pairing: ${pairingError}`
              : `Could not create replacement pairing: ${pairingError}. Could not retire relay session: ${errorMessage(retirementError)}`;
          setError(message);
          setStatusDetail(message);
        });
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
      const selectionKind =
        detail.info.rdns === QRL_CONNECT_RDNS ? "relay" : "extension";
      if (relayResetGuardRef.current.active) return;
      const attemptGeneration = connectionAttemptGuardRef.current.begin(selectionKind);
      if (attemptGeneration === null) return;
      setPickerOpen(false);
      if (selectionKind === "relay") {
        try {
          await showPairing(false, attemptGeneration);
        } catch (err) {
          const retirementError = await retireRelay();
          if (connectionAttemptGuardRef.current.isCurrent(attemptGeneration)) {
            const pairingError = errorMessage(err);
            const message =
              retirementError === null
                ? `Could not start pairing: ${pairingError}`
                : `Could not start pairing: ${pairingError}. Could not retire relay session: ${errorMessage(retirementError)}`;
            setError(message);
            if (retirementError !== null) setStatusDetail(message);
          }
        } finally {
          connectionAttemptGuardRef.current.finish(attemptGeneration);
        }
        return;
      }
      try {
        const activation = await activateExtensionAfterRelayRetirement(
          retireRelay,
          async () => {
            if (!connectionAttemptGuardRef.current.isCurrent(attemptGeneration)) {
              throw new Error("Wallet connection attempt changed");
            }
            return detail.provider.request({
              method: "qrl_requestAccounts",
            });
          },
          (accounts) => {
            if (!connectionAttemptGuardRef.current.isCurrent(attemptGeneration)) {
              throw new Error("Wallet connection attempt changed");
            }
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
          },
        );

        if (!connectionAttemptGuardRef.current.isCurrent(attemptGeneration)) return;
        if (!activation.ok) {
          const message = `Could not retire relay session: ${errorMessage(activation.retirementError)}`;
          setError(message);
          setStatusDetail(message);
          return;
        }
      } catch (err) {
        if (connectionAttemptGuardRef.current.isCurrent(attemptGeneration)) {
          setError(errorMessage(err));
        }
      } finally {
        connectionAttemptGuardRef.current.finish(attemptGeneration);
      }
    },
    [retireRelay, showPairing, setTransport],
  );

  // Explicit reset: tears down the existing relay pairing and rotates
  // channel/keys. Relay-only concept.
  const newConnection = useCallback(async () => {
    if (
      relayResetGuardRef.current.active ||
      connectionAttemptGuardRef.current.isPending()
    ) {
      return;
    }
    try {
      await showPairing(true);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not create a new connection";
      setError(message);
      setStatusDetail(message);
    }
  }, [showPairing]);

  const cancelPairing = useCallback(async () => {
    if (
      relayResetGuardRef.current.active ||
      connectionAttemptGuardRef.current.isPending()
    ) {
      return;
    }
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
    if (
      relayResetGuardRef.current.active ||
      connectionAttemptGuardRef.current.isPending()
    ) {
      return;
    }
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
