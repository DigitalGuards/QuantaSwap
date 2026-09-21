import { NavLink, Link } from "react-router";
import { Wallet, LogOut } from "lucide-react";
import { Logo } from "@/components/Logo";
import { AddressFingerprint } from "@/components/AddressFingerprint";
import { Button } from "@/components/UI/Button";
import { cn } from "@/utils/cn";
import { QRL_LEG, ETH_LEG } from "@/config";
import type { QrlStatus } from "@/hooks/useQrlWallet";
import { hasLegacySwapState } from "@/lib/activeSwap";

const navItems = [
  { to: "/", label: "Swap" },
  { to: "/sandbox", label: "Sandbox" },
  { to: "/how-it-works", label: "How it works" },
];

interface WalletSlotProps {
  label: string;
  account: string | null;
  /** Explorer address base URL; the account is appended for the deep link. */
  explorerBase: string;
  explorerName: string;
  pending?: boolean;
  onConnect: () => void;
  onDisconnect?: (() => void) | undefined;
}

function WalletSlot({
  label,
  account,
  explorerBase,
  explorerName,
  pending,
  onConnect,
  onDisconnect,
}: WalletSlotProps) {
  if (account) {
    const chainLabel = label.startsWith("QRL") ? "QRL" : "ETH";
    return (
      <div className="flex items-center gap-2">
        <a
          href={`${explorerBase}${account}`}
          target="_blank"
          rel="noreferrer"
          title={account}
          aria-label={`View ${label} ${account} on ${explorerName}`}
          className="font-data inline-flex items-center rounded-md border border-border bg-muted/40 px-3 py-1.5 text-xs text-blue-accent transition-colors hover:border-blue-accent/50"
        >
          <span className="font-sans text-[10px] font-semibold tracking-wide xl:hidden">
            {chainLabel}
          </span>
          <AddressFingerprint address={account} className="hidden xl:inline" />
        </a>
        {onDisconnect ? (
          <Button variant="ghost" size="sm" onClick={onDisconnect} aria-label={`Disconnect ${label}`}>
            <LogOut className="h-4 w-4" />
          </Button>
        ) : null}
      </div>
    );
  }
  return (
    <Button size="sm" disabled={pending} onClick={onConnect}>
      <Wallet className="h-4 w-4" />
      <span className="hidden sm:inline">{pending ? "Pairing…" : label}</span>
    </Button>
  );
}

interface Props {
  ethAccount: string | null;
  onConnectEth: () => void;
  onDisconnectEth: () => void;
  qrlAccount: string | null;
  qrlStatus: QrlStatus;
  onConnectQrl: () => void;
  onDisconnectQrl: () => void;
}

export function Header(props: Props) {
  return (
    <header className="sticky top-0 z-20 border-b border-border/60 bg-background/80 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-5xl items-center justify-between gap-4 px-4">
        <div className="flex items-center gap-6">
          <Link to="/" aria-label="QuantaSwap home">
            <Logo className="[&>span]:hidden sm:[&>span]:inline" />
          </Link>
          <nav className="hidden items-center gap-1 md:flex">
            {navItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end
                className={({ isActive }) =>
                  cn(
                    "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                    isActive
                      ? "bg-primary/10 text-primary"
                      : "text-muted-foreground hover:text-foreground",
                  )
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-3">
          <span className="hidden rounded-full border border-secondary/40 bg-secondary/10 px-2.5 py-0.5 text-xs font-medium text-secondary sm:inline">
            Private v3
          </span>
          <WalletSlot
            label="ETH wallet"
            account={props.ethAccount}
            explorerBase={ETH_LEG.explorerAddress}
            explorerName="Etherscan"
            onConnect={props.onConnectEth}
            onDisconnect={props.ethAccount ? props.onDisconnectEth : undefined}
          />
          <WalletSlot
            label="QRL wallet"
            account={props.qrlAccount}
            explorerBase={QRL_LEG.explorerAddress}
            explorerName="Zondscan"
            pending={props.qrlStatus === "pairing"}
            onConnect={props.onConnectQrl}
            onDisconnect={props.qrlAccount ? props.onDisconnectQrl : undefined}
          />
        </div>
      </div>
      {/* Mobile nav */}
      <nav className="flex items-center justify-around border-t border-border/60 py-2 md:hidden">
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end
            className={({ isActive }) =>
              cn(
                "px-3 py-1 text-sm font-medium",
                isActive ? "text-primary" : "text-muted-foreground hover:text-foreground",
              )
            }
          >
            {item.label}
          </NavLink>
        ))}
      </nav>
      {hasLegacySwapState() && (
        <p role="status" className="mx-auto max-w-5xl px-4 py-2 text-xs text-muted-foreground">
          Previous testnet swap records are preserved on this device. V3 uses a separate deployment.
          Keep your old recovery records until every earlier swap has settled.
        </p>
      )}
    </header>
  );
}
