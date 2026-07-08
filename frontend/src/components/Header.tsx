import { NavLink, Link } from "react-router-dom";
import { Wallet, LogOut } from "lucide-react";
import { Logo } from "@/components/Logo";
import { Button } from "@/components/UI/Button";
import { shortAddr } from "@/lib/htlc";
import { cn } from "@/utils/cn";
import { QRL_LEG, ETH_LEG } from "@/config";
import type { QrlStatus } from "@/hooks/useQrlWallet";

const navItems = [
  { to: "/", label: "Swap" },
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
    return (
      <div className="flex items-center gap-2">
        <a
          href={`${explorerBase}${account}`}
          target="_blank"
          rel="noreferrer"
          title={`View address on ${explorerName}`}
          className="rounded-md border border-border bg-muted/40 px-3 py-1.5 font-mono text-xs text-secondary hover:border-secondary/60"
        >
          {shortAddr(account)}
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
            <Logo />
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
                      ? "bg-secondary/10 text-secondary"
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
            Testnet
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
                isActive ? "text-secondary" : "text-muted-foreground hover:text-foreground",
              )
            }
          >
            {item.label}
          </NavLink>
        ))}
      </nav>
    </header>
  );
}
