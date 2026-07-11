import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { formatEther } from "ethers";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/UI/Card";
import { cn } from "@/utils/cn";
import { legByKey, type LegKey } from "@/config";
import type { useEthWallet } from "@/hooks/useEthWallet";
import type { useQrlWallet } from "@/hooks/useQrlWallet";
import { useAnnounceReconcile } from "@/hooks/useAnnounceReconcile";
import type { ActiveSwap } from "@/lib/activeSwap";
import { releaseTake } from "@/lib/orderbook";
import { SwapFlow } from "@/components/SwapFlow";
import { NetworkPanel } from "@/components/NetworkPanel";
import {
  getLegState,
  getSwapEvents,
  hexToQ,
  SwapStatus,
  shortAddr,
  type LegState,
  type SwapEvent,
} from "@/lib/htlc";
import { deriveVerdict, HASHLOCK_RE, type LegSnapshot } from "@/lib/swapStatus";

// Public, shareable status page for any swap, keyed by its hashlock: the
// one identifier both chains share. Everything shown is read live from
// the two HTLCs, so the page works for any visitor with the link, with
// no wallet and no order-book record.

const POLL_MS = 5000;

const pillStyles: Record<string, string> = {
  none: "bg-muted/40 text-muted-foreground",
  open: "bg-blue-accent/10 text-blue-accent",
  claimed: "bg-success/10 text-success",
  refunded: "bg-amber-400/10 text-amber-400",
};

const statusName = ["not escrowed", "escrowed", "claimed", "refunded"] as const;
const statusKey = ["none", "open", "claimed", "refunded"] as const;

const toneStyles = {
  success: "border-success/40 bg-success/10 text-success",
  pending: "border-blue-accent/40 bg-blue-accent/10 text-blue-accent",
  warn: "border-amber-400/40 bg-amber-400/10 text-amber-400",
  neutral: "border-border/60 bg-muted/20 text-muted-foreground",
} as const;

const eventLabel: Record<SwapEvent["kind"], string> = {
  locked: "lock tx",
  claimed: "claim tx",
  refunded: "refund tx",
};

function LegCard({
  leg,
  snapshot,
  events,
}: {
  leg: LegKey;
  snapshot: LegSnapshot | undefined;
  events: SwapEvent[];
}) {
  const cfg = legByKey(leg);
  const asQ = (addr: string) => (leg === "qrl" ? hexToQ(addr) : addr);
  const rows: Array<[string, string]> = [];
  if (snapshot !== null && snapshot !== undefined && snapshot.status !== SwapStatus.None) {
    rows.push(["Amount", `${formatEther(snapshot.amount)} ${cfg.asset}`]);
    rows.push(["Pays out to", asQ(snapshot.recipient)]);
    rows.push(["Locked by", asQ(snapshot.initiator)]);
    rows.push(["Timeout", new Date(snapshot.timeout * 1000).toLocaleString()]);
    if (snapshot.status === SwapStatus.Claimed) {
      rows.push(["Revealed secret", snapshot.preimage]);
    }
  }
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">{cfg.name}</CardTitle>
          {snapshot === undefined ? (
            <span className="text-xs text-muted-foreground">loading…</span>
          ) : snapshot === null ? (
            <span className="text-xs text-amber-400">chain unreachable, retrying</span>
          ) : (
            <span
              className={cn(
                "rounded-full px-2.5 py-0.5 text-xs font-medium",
                pillStyles[statusKey[snapshot.status]],
              )}
            >
              {statusName[snapshot.status]}
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {rows.length === 0 ? (
          <p className="text-muted-foreground">
            {snapshot === undefined || snapshot === null
              ? "Waiting for chain data."
              : "No escrow under this hashlock on this chain."}
          </p>
        ) : (
          rows.map(([label, value]) => (
            <div key={label} className="flex items-baseline justify-between gap-4">
              <span className="shrink-0 text-muted-foreground">{label}</span>
              <span className="break-all text-right font-data text-xs" title={value}>
                {value.length > 46 ? shortAddr(value) : value}
              </span>
            </div>
          ))
        )}
        <p className="flex flex-wrap justify-end gap-x-3 pt-1">
          {events.map((e) => (
            <a
              key={e.txHash}
              className="text-xs text-muted-foreground underline-offset-4 hover:underline"
              href={`${cfg.explorerTx}${e.txHash}`}
              target="_blank"
              rel="noreferrer"
            >
              {eventLabel[e.kind]}
            </a>
          ))}
          <a
            className="text-xs text-muted-foreground underline-offset-4 hover:underline"
            href={`${cfg.explorerAddress}${cfg.htlc}`}
            target="_blank"
            rel="noreferrer"
          >
            HTLC contract
          </a>
        </p>
      </CardContent>
    </Card>
  );
}

interface Props {
  eth: ReturnType<typeof useEthWallet>;
  qrl: ReturnType<typeof useQrlWallet>;
  swap: ActiveSwap | null;
  setSwap: (swap: ActiveSwap | null) => void;
}

export function SwapStatusPage({ eth: ethWallet, qrl: qrlWallet, swap, setSwap }: Props) {
  const { hashlock: raw } = useParams();
  const navigate = useNavigate();
  const hashlock = raw !== undefined && HASHLOCK_RE.test(raw) ? raw.toLowerCase() : null;

  // This URL is the canonical home of an active swap. When the swap in
  // local storage matches the hash, render the interactive flow (this
  // browser holds the taker token or the maker secret); any other visitor
  // gets the read-only chain view further down.
  const own =
    swap !== null &&
    hashlock !== null &&
    swap.hashlock !== null &&
    swap.hashlock.toLowerCase() === hashlock;
  useAnnounceReconcile(own ? swap : null);

  const [qrl, setQrl] = useState<LegSnapshot | undefined>(undefined);
  const [eth, setEth] = useState<LegSnapshot | undefined>(undefined);
  const [events, setEvents] = useState<Record<LegKey, SwapEvent[]>>({ qrl: [], eth: [] });
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    // SwapFlow does its own polling for the interactive view.
    if (hashlock === null || own) return;
    let alive = true;
    const read = (leg: LegKey, set: (s: LegSnapshot) => void) =>
      getLegState(leg, hashlock)
        .then((s: LegState) => {
          if (alive) set(s);
        })
        .catch(() => {
          if (alive) set(null);
        });
    const readEvents = (leg: LegKey) =>
      getSwapEvents(leg, hashlock)
        .then((list) => {
          if (alive) setEvents((prev) => ({ ...prev, [leg]: list }));
        })
        .catch(() => undefined);
    const poll = () => {
      void read("qrl", setQrl);
      void read("eth", setEth);
      void readEvents("qrl");
      void readEvents("eth");
    };
    poll();
    const t = setInterval(poll, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [hashlock, own]);

  if (hashlock === null) {
    return (
      <div className="mx-auto max-w-md pt-16 pb-16">
        <Card>
          <CardHeader>
            <CardTitle>Not a swap hash</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            A swap link looks like <span className="font-data">/swap/0x…</span> with a 32-byte
            hex hashlock. Check the link you were given.
          </CardContent>
        </Card>
      </div>
    );
  }

  if (own && swap !== null) {
    return (
      <div className="page-enter mx-auto max-w-md space-y-4 pt-10 pb-16">
        <SwapFlow
          swap={swap}
          ethAccount={ethWallet.account}
          qrlAccount={qrlWallet.account}
          browserProvider={ethWallet.browserProvider}
          ensureSepolia={ethWallet.ensureSepolia}
          qrlRequest={qrlWallet.request}
          qrlTransport={qrlWallet.kind}
          onDiscard={() => {
            releaseTake(swap);
            setSwap(null);
            navigate("/");
          }}
        />
        <NetworkPanel />
      </div>
    );
  }

  const verdict = deriveVerdict(qrl ?? null, eth ?? null);
  const loading = qrl === undefined && eth === undefined;

  return (
    <div className="page-enter mx-auto max-w-2xl space-y-4 pt-10 pb-16">
      <div className="flex items-baseline justify-between gap-4">
        <h1 className="text-2xl font-black tracking-tight">Swap status</h1>
        <button
          type="button"
          className="text-xs text-muted-foreground underline-offset-4 hover:underline"
          onClick={() => {
            void navigator.clipboard
              .writeText(window.location.href)
              .then(() => setCopied(true))
              .catch(() => undefined);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? "link copied" : "copy link"}
        </button>
      </div>
      <p className="break-all font-data text-xs text-muted-foreground" title="hashlock">
        {hashlock}
      </p>

      <div
        className={cn(
          "rounded-md border p-3 text-center text-sm font-semibold",
          toneStyles[verdict.tone],
        )}
      >
        {loading ? "Reading both chains…" : verdict.headline}
      </div>
      {loading ? null : <p className="text-sm text-muted-foreground">{verdict.detail}</p>}

      <div className="grid gap-4 sm:grid-cols-2">
        <LegCard leg="qrl" snapshot={qrl} events={events.qrl} />
        <LegCard leg="eth" snapshot={eth} events={events.eth} />
      </div>

      <p className="text-xs text-muted-foreground">
        Live from both chains, refreshed every {POLL_MS / 1000}s. Anyone with this link sees the
        same view; no wallet or account is involved. Escrows pay out only to the recipient fixed
        at lock time, so sharing this page is safe.
      </p>
    </div>
  );
}
