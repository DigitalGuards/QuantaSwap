import { useEffect, useState } from "react";
import { loadDemoSwap, saveDemoSwap, clearDemoSwap, type DemoSwap } from "@/lib/demoSwap";
import type { useEthWallet } from "@/hooks/useEthWallet";
import type { useQrlWallet } from "@/hooks/useQrlWallet";
import { SwapCard } from "@/components/SwapCard";
import { SwapFlow } from "@/components/SwapFlow";
import { NetworkPanel } from "@/components/NetworkPanel";

interface Props {
  eth: ReturnType<typeof useEthWallet>;
  qrl: ReturnType<typeof useQrlWallet>;
}

export function SwapPage({ eth, qrl }: Props) {
  const [swap, setSwap] = useState<DemoSwap | null>(() => loadDemoSwap());

  useEffect(() => {
    if (swap) saveDemoSwap(swap);
  }, [swap]);

  return (
    <div className="space-y-10 pb-16">
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
    </div>
  );
}
