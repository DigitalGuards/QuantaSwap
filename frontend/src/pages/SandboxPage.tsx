import { Link } from "react-router-dom";
import type { useEthWallet } from "@/hooks/useEthWallet";
import type { useQrlWallet } from "@/hooks/useQrlWallet";
import type { ActiveSwap } from "@/lib/activeSwap";
import { SwapCard } from "@/components/SwapCard";
import { SwapFlow } from "@/components/SwapFlow";
import { NetworkPanel } from "@/components/NetworkPanel";

interface Props {
  eth: ReturnType<typeof useEthWallet>;
  qrl: ReturnType<typeof useQrlWallet>;
  swap: ActiveSwap | null;
  setSwap: (swap: ActiveSwap | null) => void;
}

/** The original single-browser demo: one person plays both sides of the
 *  HTLC handshake, useful for testing and for watching the protocol work
 *  without a counterparty. */
export function SandboxPage({ eth, qrl, swap, setSwap }: Props) {
  return (
    <div className="space-y-10 pb-16">
      <section className="pt-10 pb-2 text-center">
        <h1 className="text-3xl font-black tracking-tight md:text-4xl">Sandbox</h1>
        <p className="mx-auto mt-4 max-w-xl text-muted-foreground">
          Play both sides of an atomic swap from one browser and watch the HTLC handshake happen
          live on both chains. Rates are whatever you enter; funds move between your own accounts.
        </p>
      </section>

      <section className="mx-auto max-w-md space-y-4">
        {eth.error ? <p className="text-sm text-red-400">{eth.error}</p> : null}
        {qrl.error ? <p className="text-sm text-red-400">{qrl.error}</p> : null}

        {swap ? (
          swap.role === "sandbox" ? (
            <SwapFlow
              swap={swap}
              ethAccount={eth.account}
              qrlAccount={qrl.account}
              browserProvider={eth.browserProvider}
              ensureSepolia={eth.ensureSepolia}
              qrlRequest={qrl.request}
              qrlTransport={qrl.kind}
              onDiscard={() => setSwap(null)}
            />
          ) : (
            <p className="rounded-md border border-border/60 bg-muted/20 p-3 text-sm text-muted-foreground">
              A market swap is in progress. Finish or discard it on the{" "}
              <Link to="/" className="text-secondary underline">
                Swap page
              </Link>{" "}
              before starting a sandbox run.
            </p>
          )
        ) : (
          <SwapCard ethAccount={eth.account} qrlAccount={qrl.account} onStart={setSwap} />
        )}

        <NetworkPanel />
      </section>
    </div>
  );
}
