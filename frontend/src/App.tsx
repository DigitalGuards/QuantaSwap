import { useEffect, useState } from "react";
import { GITHUB_URL } from "./config";
import { loadDemoSwap, saveDemoSwap, clearDemoSwap, type DemoSwap } from "./lib/demoSwap";
import { useEthWallet } from "./hooks/useEthWallet";
import { useQrlWallet } from "./hooks/useQrlWallet";
import { Header } from "./components/Header";
import { QrModal } from "./components/QrModal";
import { SwapCard } from "./components/SwapCard";
import { SwapFlow } from "./components/SwapFlow";
import { NetworkPanel } from "./components/NetworkPanel";

export default function App() {
  const eth = useEthWallet();
  const qrl = useQrlWallet();
  const [swap, setSwap] = useState<DemoSwap | null>(() => loadDemoSwap());

  useEffect(() => {
    if (swap) saveDemoSwap(swap);
  }, [swap]);

  return (
    <>
      <Header
        ethAccount={eth.account}
        ethWalletName={eth.walletName}
        onConnectEth={() => void eth.connect()}
        qrlAccount={qrl.account}
        qrlStatus={qrl.status}
        onConnectQrl={() => void qrl.connect()}
        onDisconnectQrl={() => void qrl.disconnect()}
      />

      {eth.error ? <div className="error" style={{ marginBottom: 10 }}>{eth.error}</div> : null}
      {qrl.error ? <div className="error" style={{ marginBottom: 10 }}>{qrl.error}</div> : null}

      {swap ? (
        <SwapFlow
          swap={swap}
          browserProvider={eth.browserProvider}
          ensureSepolia={eth.ensureSepolia}
          qrlRequest={qrl.request}
          onDiscard={() => {
            clearDemoSwap();
            setSwap(null);
          }}
        />
      ) : (
        <SwapCard ethAccount={eth.account} qrlAccount={qrl.account} onStart={setSwap} />
      )}

      <NetworkPanel />

      <footer className="footer">
        Cross-chain atomic swaps between Ethereum and QRL. Testnet only; native ETH and QRL in this
        demo, WETH already supported at the contract level.
        <br />
        <a href={GITHUB_URL} target="_blank" rel="noreferrer">
          GitHub
        </a>{" "}
        · GPL-3.0 · part of the MyQRLWallet ecosystem
      </footer>

      {qrl.uri ? <QrModal uri={qrl.uri} onCancel={qrl.cancelPairing} /> : null}
    </>
  );
}
