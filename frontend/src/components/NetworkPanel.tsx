import { useEffect, useState } from "react";
import { ETH_LEG, QRL_LEG } from "../config";
import { getBlockNumber, shortAddr } from "../lib/htlc";

export function NetworkPanel() {
  const [heights, setHeights] = useState<{ eth?: number; qrl?: number }>({});

  useEffect(() => {
    const poll = () => {
      void getBlockNumber("qrl").then((n) => setHeights((h) => ({ ...h, qrl: n }))).catch(() => undefined);
      void getBlockNumber("eth").then((n) => setHeights((h) => ({ ...h, eth: n }))).catch(() => undefined);
    };
    poll();
    const t = setInterval(poll, 15000);
    return () => clearInterval(t);
  }, []);

  const cell = (leg: typeof QRL_LEG | typeof ETH_LEG, height: number | undefined, addressUrl: string) => (
    <div className="net-cell">
      <div className="title">
        {leg.name} · block {height ?? "…"}
      </div>
      <div className="val mono">
        HTLC{" "}
        <a href={addressUrl} target="_blank" rel="noreferrer">
          {shortAddr(leg.htlc)}
        </a>
      </div>
    </div>
  );

  return (
    <div className="card">
      <h2>Live contracts</h2>
      <div className="net-grid">
        {cell(QRL_LEG, heights.qrl, `https://zondscan.com/address/${QRL_LEG.htlc}`)}
        {cell(ETH_LEG, heights.eth, `https://sepolia.etherscan.io/address/${ETH_LEG.htlc}`)}
      </div>
      <p className="muted" style={{ marginBottom: 0, marginTop: 12 }}>
        One Hyperion source, byte-identical bytecode on both chains. No owner, no pause, no upgrade
        path: claims and refunds are enforced by the contracts alone.
      </p>
    </div>
  );
}
