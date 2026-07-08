import { useState } from "react";
import { parseEther } from "ethers";
import { ETH_LEG, INITIATOR_TIMEOUT_S, QRL_LEG, RESPONDER_TIMEOUT_S } from "../config";
import type { DemoSwap } from "../lib/demoSwap";
import { generateSecret } from "../lib/secrets";
import { shortAddr } from "../lib/htlc";

interface Props {
  ethAccount: string | null;
  qrlAccount: string | null;
  onStart: (swap: DemoSwap) => void;
}

export function SwapCard({ ethAccount, qrlAccount, onStart }: Props) {
  const [direction, setDirection] = useState<DemoSwap["direction"]>("eth->qrl");
  const [fromAmount, setFromAmount] = useState("");
  const [toAmount, setToAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const fromLeg = direction === "eth->qrl" ? ETH_LEG : QRL_LEG;
  const toLeg = direction === "eth->qrl" ? QRL_LEG : ETH_LEG;

  const ready = Boolean(ethAccount && qrlAccount && Number(fromAmount) > 0 && Number(toAmount) > 0);

  const start = async () => {
    if (!ethAccount || !qrlAccount) return;
    setError(null);
    setBusy(true);
    try {
      const secret = await generateSecret();
      const now = Math.floor(Date.now() / 1000);
      onStart({
        direction,
        preimage: secret.preimage,
        hashlock: secret.hashlock,
        fromAmount: parseEther(fromAmount).toString(),
        toAmount: parseEther(toAmount).toString(),
        ethAccount,
        qrlAccount,
        initiatorTimeout: now + INITIATOR_TIMEOUT_S,
        responderTimeout: now + RESPONDER_TIMEOUT_S,
        createdAt: now,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid amount");
    } finally {
      setBusy(false);
    }
  };

  const legBox = (
    kind: "From" | "To",
    leg: typeof ETH_LEG | typeof QRL_LEG,
    value: string,
    setValue: (v: string) => void
  ) => (
    <div className="leg-box">
      <div className="label">{kind}</div>
      <div className="leg-row">
        <div className="asset">
          <div className={`glyph ${leg.key}`}>{leg.asset === "ETH" ? "Ξ" : "Q"}</div>
          <div className="names">
            <b>{leg.asset}</b>
            <span>{leg.name}</span>
          </div>
        </div>
        <input
          className="amount"
          inputMode="decimal"
          placeholder="0.0"
          value={value}
          onChange={(e) => setValue(e.target.value.replace(/[^0-9.]/g, ""))}
        />
      </div>
    </div>
  );

  return (
    <div className="card">
      <h2>Atomic swap</h2>
      {legBox("From", fromLeg, fromAmount, setFromAmount)}
      <div className="switcher">
        <button
          aria-label="switch direction"
          onClick={() => {
            setDirection((d) => (d === "eth->qrl" ? "qrl->eth" : "eth->qrl"));
            setFromAmount(toAmount);
            setToAmount(fromAmount);
          }}
        >
          ↓
        </button>
      </div>
      {legBox("To", toLeg, toAmount, setToAmount)}
      <div className="field-note">
        <span>
          Receive to:{" "}
          <span className="mono">
            {toLeg.key === "qrl" ? (qrlAccount ? shortAddr(qrlAccount) : "connect QRL wallet") : ethAccount ? shortAddr(ethAccount) : "connect ETH wallet"}
          </span>
        </span>
        <span>HTLC protocol mode</span>
      </div>
      <button className="btn" disabled={!ready || busy} onClick={() => void start()}>
        {ethAccount && qrlAccount ? "Start atomic swap" : "Connect both wallets to swap"}
      </button>
      {error ? <div className="error">{error}</div> : null}
      <p className="muted" style={{ marginBottom: 0, marginTop: 12 }}>
        Protocol-mode sandbox: no order book yet, so you act as both sides of the swap and can watch
        the HTLC handshake happen live on both chains. Rates are whatever you enter.
      </p>
    </div>
  );
}
