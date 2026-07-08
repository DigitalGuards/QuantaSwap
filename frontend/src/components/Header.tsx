import { Wallet, LogOut } from "lucide-react";
import { Logo } from "@/components/Logo";
import { Button } from "@/components/UI/Button";
import { shortAddr } from "@/lib/htlc";
import type { QrlStatus } from "@/hooks/useQrlWallet";

interface WalletSlotProps {
  label: string;
  account: string | null;
  pending?: boolean;
  onConnect: () => void;
  onDisconnect?: (() => void) | undefined;
}

function WalletSlot({ label, account, pending, onConnect, onDisconnect }: WalletSlotProps) {
  if (account) {
    return (
      <div className="flex items-center gap-2">
        <span
          className="rounded-md border border-border bg-muted/40 px-3 py-1.5 font-mono text-xs text-secondary"
          title={account}
        >
          {shortAddr(account)}
        </span>
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
  qrlAccount: string | null;
  qrlStatus: QrlStatus;
  onConnectQrl: () => void;
  onDisconnectQrl: () => void;
}

export function Header(props: Props) {
  return (
    <header className="sticky top-0 z-20 border-b border-border/60 bg-background/80 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-5xl items-center justify-between gap-4 px-4">
        <Logo />
        <div className="flex items-center gap-3">
          <span className="hidden rounded-full border border-secondary/40 bg-secondary/10 px-2.5 py-0.5 text-xs font-medium text-secondary sm:inline">
            Testnet
          </span>
          <WalletSlot label="ETH wallet" account={props.ethAccount} onConnect={props.onConnectEth} />
          <WalletSlot
            label="QRL wallet"
            account={props.qrlAccount}
            pending={props.qrlStatus === "pairing"}
            onConnect={props.onConnectQrl}
            onDisconnect={props.qrlAccount ? props.onDisconnectQrl : undefined}
          />
        </div>
      </div>
    </header>
  );
}
