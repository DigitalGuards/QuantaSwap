import { useEffect, useState } from "react";
import QRCode from "qrcode";

interface Props {
  uri: string;
  onCancel: () => void;
}

export function QrModal({ uri, onCancel }: Props) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    void QRCode.toDataURL(uri, { margin: 1, width: 480 }).then((url) => {
      if (alive) setDataUrl(url);
    });
    return () => {
      alive = false;
    };
  }, [uri]);

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 style={{ marginTop: 0 }}>Pair MyQRLWallet</h2>
        <p className="muted">
          Scan with the QRL Wallet app, or open the wallet at{" "}
          <a href="https://qrlwallet.com" target="_blank" rel="noreferrer">
            qrlwallet.com
          </a>{" "}
          and use its dApp scanner.
        </p>
        {dataUrl ? <img src={dataUrl} alt="qrlconnect pairing QR code" /> : <p>Generating…</p>}
        <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 14 }}>
          <button
            className="btn ghost"
            onClick={() => {
              void navigator.clipboard.writeText(uri).then(() => setCopied(true));
            }}
          >
            {copied ? "Copied" : "Copy URI"}
          </button>
          <button className="btn ghost" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
