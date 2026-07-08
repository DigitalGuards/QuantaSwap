// QRL leg wallet via @qrlwallet/connect: QR pairing to MyQRLWallet
// (web/mobile/desktop), post-quantum encrypted relay session.

import { useCallback, useEffect, useRef, useState } from "react";
import { QRLConnect } from "@qrlwallet/connect";

export type QrlStatus = "disconnected" | "pairing" | "connected";

export function useQrlWallet() {
  const sdkRef = useRef<QRLConnect | null>(null);
  const [status, setStatus] = useState<QrlStatus>("disconnected");
  const [account, setAccount] = useState<string | null>(null);
  const [uri, setUri] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sdk = useCallback((): QRLConnect => {
    if (!sdkRef.current) {
      sdkRef.current = new QRLConnect({
        dappMetadata: { name: "QuantaSwap", url: "https://quantaswap.io" },
      });
    }
    return sdkRef.current;
  }, []);

  useEffect(() => {
    const qrl = sdk();
    const onConnect = () => {
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
    const onDisconnect = () => {
      setStatus("disconnected");
      setAccount(null);
    };
    qrl.on("connect", onConnect);
    qrl.on("accountsChanged", onAccounts);
    qrl.on("disconnect", onDisconnect);
    // auto-reconnect from a stored session
    if (qrl.isConnected()) onConnect();
    return () => {
      qrl.off("connect", onConnect);
      qrl.off("accountsChanged", onAccounts);
      qrl.off("disconnect", onDisconnect);
    };
  }, [sdk]);

  const connect = useCallback(async () => {
    setError(null);
    try {
      const qrl = sdk();
      const connectionUri = qrl.hasStoredSession()
        ? await qrl.newConnection()
        : await qrl.getConnectionURI();
      if (qrl.isMobile()) {
        window.location.href = connectionUri;
        return;
      }
      setUri(connectionUri);
      setStatus("pairing");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start pairing");
      setStatus("disconnected");
    }
  }, [sdk]);

  const cancelPairing = useCallback(() => {
    setUri(null);
    if (status === "pairing") setStatus("disconnected");
  }, [status]);

  const disconnect = useCallback(async () => {
    await sdk().disconnect();
    setStatus("disconnected");
    setAccount(null);
  }, [sdk]);

  const request = useCallback(
    (args: { method: string; params?: unknown[] }) => sdk().request(args as never),
    [sdk]
  );

  return { status, account, uri, error, connect, cancelPairing, disconnect, request };
}
