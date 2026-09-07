import { useEffect, useState } from "react";
import { ETH_LEG, QRL_LEG } from "@/config";
import { getBlockNumber, shortAddr } from "@/lib/htlc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/UI/Card";

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
    <div className="space-y-1.5 rounded-md border border-border/60 bg-muted/20 p-3 text-sm">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <span
            aria-hidden
            className={
              height !== undefined
                ? "glow-dot h-1.5 w-1.5 rounded-full bg-current text-success"
                : "h-1.5 w-1.5 rounded-full bg-current text-muted-foreground/60"
            }
          />
          {leg.name}
        </span>
        <span className="font-data text-xs text-muted-foreground">block {height ?? "…"}</span>
      </div>
      <div className="font-data text-xs">
        HTLC{" "}
        <a
          href={addressUrl}
          target="_blank"
          rel="noreferrer"
          className="text-identity-accent hover:underline"
        >
          {shortAddr(leg.htlc)}
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
          One Hyperion source, byte-identical bytecode on both chains. No owner, no pause, no
          upgrade path: claims and refunds are enforced by the contracts alone.
        </p>
      </CardContent>
    </Card>
  );
}
