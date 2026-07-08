// QRL leg wallet via @qrlwallet/connect: QR pairing to MyQRLWallet
// (web/mobile/desktop), post-quantum encrypted relay session. Pairing UX
// mirrors the reference dApp example (zondscan.com/dapp-example):
// getConnectionURI() for first connect + auto-reconnect, newConnection()
// only as an explicit reset, desktop qrlconnect:// deep link + copy-code
// fallback, QR auto-regeneration on wallet-initiated disconnect.

import { useCallback, useEffect, useRef, useState } from "react";
import { QRLConnect, type ConnectionStatus } from "@qrlwallet/connect";

export type QrlStatus = "disconnected" | "pairing" | "connected";

export function useQrlWallet() {
  const sdkRef = useRef<QRLConnect | null>(null);
  const userDisconnectedRef = useRef(false);
  const wasConnectedRef = useRef(false);
  const [status, setStatus] = useState<QrlStatus>("disconnected");
  const [statusDetail, setStatusDetail] = useState<string>("");
  const [account, setAccount] = useState<string | null>(null);
  const [uri, setUri] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  const showPairing = useCallback(
    async (fresh: boolean) => {
      setError(null);
      const qrl = sdk();
      const connectionUri = fresh ? await qrl.newConnection() : await qrl.getConnectionURI();
      if (qrl.isMobile()) {
        window.location.href = connectionUri;
        return;
      }
      setUri(connectionUri);
      setStatus("pairing");
    },
    [sdk]
  );

  useEffect(() => {
    const qrl = sdk();
    const onConnect = () => {
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
    const onAccounts = (accounts: string[]) => setAccount(accounts[0] ?? null);
    const onStatus = (s: ConnectionStatus) => setStatusDetail(String(s));
    const onDisconnect = () => {
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
  }, [sdk, showPairing]);

  const connect = useCallback(async () => {
    try {
      await showPairing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start pairing");
      setStatus("disconnected");
    }
  }, [showPairing]);

  // Explicit reset: tears down the existing pairing and rotates channel/keys.
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
    await sdk().disconnect();
    setStatus("disconnected");
    setAccount(null);
  }, [sdk]);

  const request = useCallback(
    (args: { method: string; params?: unknown[] }) => sdk().request(args as never),
    [sdk]
  );

  return {
    status,
    statusDetail,
    account,
    uri,
    error,
    connect,
    newConnection,
    cancelPairing,
    disconnect,
    request,
  };
}
