import { useEffect, useState } from "react";
import { loadDemoSwap, saveDemoSwap, clearDemoSwap, type DemoSwap } from "@/lib/demoSwap";
import { useEthWallet } from "@/hooks/useEthWallet";
import { useQrlWallet } from "@/hooks/useQrlWallet";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { QrModal } from "@/components/QrModal";
import { SwapCard } from "@/components/SwapCard";
import { SwapFlow } from "@/components/SwapFlow";
import { NetworkPanel } from "@/components/NetworkPanel";

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
        onConnectEth={() => void eth.connect()}
        qrlAccount={qrl.account}
        qrlStatus={qrl.status}
        onConnectQrl={() => void qrl.connect()}
        onDisconnectQrl={() => void qrl.disconnect()}
      />

      <main className="mx-auto w-full max-w-5xl flex-1 space-y-10 px-4 pb-16">
        <section className="relative pt-10 pb-2 text-center">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 -top-16 h-64 bg-[radial-gradient(ellipse_at_top,hsl(25_95%_53%/0.10),transparent_65%)]"
          />
          <h1 className="text-3xl font-black tracking-tight md:text-5xl">
            Atomic swaps for <span className="text-secondary">QRL</span>
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-muted-foreground">
            Swap between Ethereum and QRL with no custodian and no bridge. Hashed timelock
            contracts on both chains; every swap completes atomically or refunds.
          </p>
        </section>

        <section className="mx-auto max-w-md space-y-4">
          {eth.error ? <p className="text-sm text-red-400">{eth.error}</p> : null}
          {qrl.error ? <p className="text-sm text-red-400">{qrl.error}</p> : null}

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
        </section>
      </main>

      <Footer />

      {qrl.uri ? (
        <QrModal
          uri={qrl.uri}
          statusDetail={qrl.statusDetail}
          onNewConnection={() => void qrl.newConnection()}
          onCancel={qrl.cancelPairing}
        />
      ) : null}
    </>
  );
}
