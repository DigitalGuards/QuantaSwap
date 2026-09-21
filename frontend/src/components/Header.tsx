import { NavLink, Link } from "react-router";
import { Wallet, LogOut } from "lucide-react";
import { Logo } from "@/components/Logo";
import { AddressFingerprint } from "@/components/AddressFingerprint";
import { Button } from "@/components/UI/Button";
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
      <div className="flex items-center gap-1">
        <a
          href={`${explorerBase}${account}`}
          target="_blank"
          rel="noreferrer"
          title={account}
          aria-label={`View ${label} ${account} on ${explorerName}`}
          className="font-data inline-flex min-h-9 items-center gap-2 whitespace-nowrap rounded-md border border-identity-accent/15 bg-identity-accent/[0.04] px-2.5 text-xs text-identity-accent transition-colors hover:border-identity-accent/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <span className="font-sans text-[10px] font-semibold tracking-wide xl:hidden">
            {chainLabel}
          </span>
          <AddressFingerprint address={account} className="hidden xl:inline" />
        </a>
        {onDisconnect ? (
          <Button
            variant="ghost"
            size="sm"
            className="px-2 text-muted-foreground"
            onClick={onDisconnect}
            aria-label={`Disconnect ${label}`}
          >
            <LogOut className="h-4 w-4" />
          </Button>
        ) : null}
      </div>
    );
  }
  return (
    <Button size="sm" disabled={pending} onClick={onConnect} aria-label={`Connect ${label}`}>
      <Wallet className="h-4 w-4" />
      <span>{pending ? "Pairing…" : label}</span>
    </Button>
  );
}

interface Props {
  ethAccount: string | null;
  ethPending?: boolean;
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
      <div className="mx-auto flex min-h-18 max-w-5xl flex-wrap items-center justify-between gap-x-4 gap-y-3 px-4 py-3 sm:flex-nowrap sm:py-0">
        <div className="flex items-center gap-8 sm:self-stretch">
          <Link to="/" aria-label="QuantaSwap home">
            <Logo className="[&>span]:hidden sm:[&>span]:inline" />
          </Link>
          <nav aria-label="Main navigation" className="hidden items-stretch gap-6 lg:flex">
            {navItems.map((item) => (
              <NavLink key={item.to} to={item.to} end className="header-nav-link">
                {item.label}
              </NavLink>
            ))}
          </nav>
        </div>
        <span className="text-xs font-medium text-muted-foreground sm:hidden">Private v3</span>
        <div className="flex w-full items-center justify-end gap-3 sm:w-auto">
          <span className="mr-1 hidden text-xs font-medium text-muted-foreground sm:inline">
            Private v3
          </span>
          <WalletSlot
            label="ETH wallet"
            account={props.ethAccount}
            explorerBase={ETH_LEG.explorerAddress}
            explorerName="Etherscan"
            pending={props.ethPending ?? false}
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
      <nav
        aria-label="Mobile navigation"
        className="flex items-center justify-around border-t border-border/60 lg:hidden"
      >
        {navItems.map((item) => (
          <NavLink key={item.to} to={item.to} end className="header-nav-link">
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
