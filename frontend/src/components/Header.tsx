import { shortAddr } from "../lib/htlc";
import type { QrlStatus } from "../hooks/useQrlWallet";

const Logo = () => (
  <svg width="30" height="30" viewBox="0 0 32 32" aria-hidden>
    <circle cx="16" cy="16" r="14" fill="#0f1630" stroke="#26305c" />
    <path
      d="M9 13a7 7 0 0 1 12-3l2 2m0-5v5h-5"
      stroke="#22d3ee"
      strokeWidth="2.4"
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M23 19a7 7 0 0 1-12 3l-2-2m0 5v-5h5"
      stroke="#8b5cf6"
      strokeWidth="2.4"
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

interface Props {
  ethAccount: string | null;
  ethWalletName: string | null;
  onConnectEth: () => void;
  qrlAccount: string | null;
  qrlStatus: QrlStatus;
  onConnectQrl: () => void;
  onDisconnectQrl: () => void;
}

export function Header(props: Props) {
  return (
    <header className="header">
      <div className="brand">
        <Logo />
        QuantaSwap
        <small>TESTNET</small>
      </div>
      <div className="wallets">
        <button className={`chip ${props.ethAccount ? "connected" : ""}`} onClick={props.onConnectEth}>
          <span className="dot" />
          {props.ethAccount ? (
            <>
              <span className="mono">{shortAddr(props.ethAccount)}</span>
              <span className="net">{props.ethWalletName ?? "Sepolia"}</span>
            </>
          ) : (
            "Connect ETH wallet"
          )}
        </button>
        <button
          className={`chip ${props.qrlAccount ? "connected" : ""}`}
          onClick={props.qrlAccount ? props.onDisconnectQrl : props.onConnectQrl}
          title={props.qrlAccount ? "Click to disconnect" : undefined}
        >
          <span className="dot" />
          {props.qrlAccount ? (
            <>
              <span className="mono">{shortAddr(props.qrlAccount)}</span>
              <span className="net">MyQRLWallet</span>
            </>
          ) : props.qrlStatus === "pairing" ? (
            "Pairing…"
          ) : (
            "Connect QRL wallet"
          )}
        </button>
      </div>
    </header>
  );
}
