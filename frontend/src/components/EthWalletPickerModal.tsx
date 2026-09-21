import { useEffect, useRef } from "react";
import { ArrowUpRight, ChevronRight, Loader2, Smartphone, Wallet, X } from "lucide-react";
import type { ProviderDetail } from "@/hooks/useEthWallet";

interface Props {
  open: boolean;
  wallets: ProviderDetail[];
  pendingId: string | null;
  error: string | null;
  onSelect: (wallet: ProviderDetail) => void;
  onMetaMask: () => void;
  onClose: () => void;
}

export function EthWalletPickerModal({
  open,
  wallets,
  pendingId,
  error,
  onSelect,
  onMetaMask,
  onClose,
}: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!open || !dialog) return;
    const previousFocus = document.activeElement;
    dialog.showModal();
    return () => {
      dialog.close();
      if (previousFocus instanceof HTMLElement) previousFocus.focus();
    };
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="eth-wallet-title"
      aria-describedby="eth-wallet-description"
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const controls = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), a[href]"),
        );
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < bounds.left ||
          event.clientX > bounds.right ||
          event.clientY < bounds.top ||
          event.clientY > bounds.bottom
        )
          onClose();
      }}
      className="m-auto max-h-[calc(100svh-2rem)] w-[calc(100%-2rem)] max-w-sm overflow-y-auto rounded-xl border border-border bg-popover p-0 text-foreground shadow-2xl backdrop:bg-black/70 backdrop:backdrop-blur-sm"
    >
      <div className="border-b border-border px-6 pb-5 pt-6">
        <div className="flex items-start justify-between gap-4">
          <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary">
            <Wallet className="h-5 w-5" />
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close wallet chooser"
            className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <h2 id="eth-wallet-title" className="text-xl font-semibold">
          Connect an ETH wallet
        </h2>
        <p id="eth-wallet-description" className="mt-2 text-sm text-muted-foreground">
          Choose your wallet to use Ethereum Sepolia.
        </p>
      </div>
      <div className="space-y-5 p-6">
        {wallets.length > 0 ? (
          <div>
            <p className="mb-2 text-xs font-medium text-muted-foreground">Installed wallets</p>
            <div className="space-y-2">
              {wallets.map((wallet) => (
                <button
                  type="button"
                  key={wallet.info.uuid}
                  disabled={pendingId !== null}
                  onClick={() => onSelect(wallet)}
                  className="flex min-h-16 w-full cursor-pointer items-center gap-3 rounded-lg border border-border bg-foreground/[0.02] px-4 py-3 text-left transition-colors hover:border-identity-accent/40 hover:bg-identity-accent/[0.04] focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-wait disabled:opacity-60"
                >
                  {wallet.info.icon.startsWith("data:image/") ? (
                    <img src={wallet.info.icon} alt="" className="h-8 w-8 rounded-md" />
                  ) : (
                    <Wallet className="h-8 w-8 text-identity-accent" />
                  )}
                  <span className="flex-1 font-medium">{wallet.info.name}</span>
                  {pendingId === wallet.info.uuid ? (
                    <Loader2
                      aria-label="Waiting for wallet"
                      className="h-4 w-4 animate-spin text-identity-accent"
                    />
                  ) : (
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  )}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            You can connect with MetaMask on your phone, or install a browser wallet.
          </p>
        )}
        <div>
          <p className="mb-2 text-xs font-medium text-muted-foreground">Use your phone</p>
          <button
            type="button"
            disabled={pendingId !== null}
            onClick={onMetaMask}
            className="flex min-h-16 w-full cursor-pointer items-center gap-3 rounded-lg border border-border px-4 py-3 text-left transition-colors hover:border-identity-accent/40 hover:bg-identity-accent/[0.04] focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-60"
          >
            <Smartphone className="h-8 w-8 text-identity-accent" />
            <span className="flex-1">
              <span className="block font-medium">MetaMask mobile</span>
              <span className="text-xs text-muted-foreground">Scan a QR code or open the app</span>
            </span>
            <ArrowUpRight className="h-4 w-4 text-muted-foreground" />
          </button>
        </div>
        {pendingId ? (
          <p role="status" className="text-sm text-identity-accent">
            Confirm the connection in your wallet.
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </div>
      <div className="border-t border-border px-6 py-4 text-xs text-muted-foreground">
        New to Ethereum wallets?{" "}
        <a
          href="https://metamask.io/download"
          target="_blank"
          rel="noreferrer"
          className="text-identity-accent underline-offset-4 hover:underline"
        >
          Get MetaMask
        </a>
      </div>
    </dialog>
  );
}
