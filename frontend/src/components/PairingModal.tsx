import { useEffect, useRef } from "react";
import { defineQrlPairingModal, QrlPairingModal } from "@qrlwallet/connect-ui";

interface Props {
  uri: string;
  statusDetail: string;
  onNewConnection: () => void;
  onCancel: () => void;
}

/**
 * Thin React wrapper around <qrl-pairing-modal> from @qrlwallet/connect-ui,
 * replacing the hand-copied QR modal. Attributes sync via effects; the
 * element's qrl-new-connection / qrl-cancel events map onto the wallet hook.
 */
export function PairingModal({ uri, statusDetail, onNewConnection, onCancel }: Props) {
  const hostRef = useRef<HTMLSpanElement | null>(null);
  const elRef = useRef<QrlPairingModal | null>(null);
  const handlers = useRef({ onNewConnection, onCancel });
  handlers.current = { onNewConnection, onCancel };

  useEffect(() => {
    defineQrlPairingModal();
    const el = new QrlPairingModal();
    const onNew = () => handlers.current.onNewConnection();
    const onDismiss = () => void handlers.current.onCancel();
    el.addEventListener("qrl-new-connection", onNew);
    el.addEventListener("qrl-cancel", onDismiss);
    hostRef.current?.append(el);
    elRef.current = el;
    return () => {
      // Listeners off before remove(): removal fires qrl-cancel by design
      // (external-unmount dismissal), which must not loop back into React.
      el.removeEventListener("qrl-new-connection", onNew);
      el.removeEventListener("qrl-cancel", onDismiss);
      el.remove();
      elRef.current = null;
    };
  }, []);

  useEffect(() => {
    elRef.current?.setAttribute("uri", uri);
  }, [uri]);

  useEffect(() => {
    if (statusDetail) elRef.current?.setAttribute("status", statusDetail);
    else elRef.current?.removeAttribute("status");
  }, [statusDetail]);

  return <span ref={hostRef} />;
}
