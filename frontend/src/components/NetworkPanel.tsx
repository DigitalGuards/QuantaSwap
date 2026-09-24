import { useEffect, useState } from "react";
import { ETH_LEG, QRL_LEG } from "@/config";
import { getBlockNumber } from "@/lib/htlc";
import { AddressFingerprint } from "@/components/AddressFingerprint";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/UI/Card";

/** Compact single-ellipsis form for the QRL HTLC address in this card. The
 *  shared three-segment fingerprint (lib/qrlAddress.ts) is deliberately
 *  longer for maker/order identity elsewhere, but here it needs to sit on
 *  one line next to "HTLC", same shape as the Sepolia row's shortAddr.
 *  The full address stays in the link's href/title. */
const compactQrlAddr = (addr: string): string =>
  addr.length > 20 ? `${addr.slice(0, 9)}…${addr.slice(-8)}` : addr;

export function NetworkPanel() {
  const [heights, setHeights] = useState<{ eth?: number; qrl?: number }>({});

  useEffect(() => {
    const poll = () => {
      void getBlockNumber("qrl")
        .then((n) => setHeights((h) => ({ ...h, qrl: n })))
        .catch(() => undefined);
      void getBlockNumber("eth")
        .then((n) => setHeights((h) => ({ ...h, eth: n })))
        .catch(() => undefined);
    };
    poll();
    const t = setInterval(poll, 15000);
    return () => clearInterval(t);
  }, []);

  const cell = (
    leg: typeof QRL_LEG | typeof ETH_LEG,
    height: number | undefined,
    addressUrl: string,
  ) => (
    <div className="min-w-0 space-y-1.5 rounded-md border border-border/60 bg-muted/20 p-3 text-sm">
      <div className="space-y-0.5">
        <span className="flex items-center gap-1.5 whitespace-nowrap text-muted-foreground">
          <span
            aria-hidden
            className={
              height !== undefined
                ? "glow-dot h-1.5 w-1.5 shrink-0 rounded-full bg-current text-success"
                : "h-1.5 w-1.5 shrink-0 rounded-full bg-current text-muted-foreground/60"
            }
          />
          {leg.name}
        </span>
        <span className="font-numeric block pl-3 text-xs text-muted-foreground">
          block {height ?? "…"}
        </span>
      </div>
      <div className="font-data text-xs">
        HTLC{" "}
        <a
          href={addressUrl}
          target="_blank"
          rel="noreferrer"
          title={leg.htlc}
          aria-label={`View ${leg.name} HTLC ${leg.htlc} on explorer`}
          className="whitespace-nowrap text-blue-accent hover:underline"
        >
          {leg.key === "qrl" ? compactQrlAddr(leg.htlc) : <AddressFingerprint address={leg.htlc} />}
        </a>
      </div>
    </div>
  );

  return (
    <Card>
      <CardHeader className="pb-4">
        <CardTitle className="text-xl">Live contracts</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          {cell(QRL_LEG, heights.qrl, `https://zondscan.com/address/${QRL_LEG.htlc}`)}
          {cell(ETH_LEG, heights.eth, `https://sepolia.etherscan.io/address/${ETH_LEG.htlc}`)}
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          One reviewed Hyperion source, compiled for each chain. No owner, no pause, no upgrade
          path: claims and refunds are enforced by the contracts alone.
        </p>
      </CardContent>
    </Card>
  );
}
