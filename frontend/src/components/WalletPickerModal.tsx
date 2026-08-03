import { X } from "lucide-react";
import type { DiscoveredQrlWallet } from "@/hooks/useQrlWallet";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/UI/Card";

interface Props {
  open: boolean;
  wallets: DiscoveredQrlWallet[];
  onSelect: (uuid: string) => void;
  onClose: () => void;
}

/**
 * EIP-6963 picker for the QRL leg. Lists the QRL-capable wallets the hook
 * discovered (the QRL browser extension and MyQRLWallet via the connect
 * relay); a click runs the matching connect path. Ported from QuantaPool.
 */
export function WalletPickerModal({ open, wallets, onSelect, onClose }: Props) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-background/80 p-4 backdrop-blur"
      onClick={onClose}
    >
      <Card className="w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg">Connect a QRL wallet</CardTitle>
            <button
              onClick={onClose}
              aria-label="Close"
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <p className="text-xs text-muted-foreground">
            The QRL browser extension and MyQRLWallet (mobile and desktop) are detected
            automatically via EIP-6963.
          </p>
        </CardHeader>
        <CardContent className="space-y-2">
          {wallets.length === 0 ? (
            <p className="rounded-md border border-border bg-muted/40 p-3 text-center text-sm text-muted-foreground">
              No QRL wallets detected. Install the QRL Web3 Wallet extension, or use MyQRLWallet
              on mobile or desktop.
            </p>
          ) : (
            wallets.map((w) => (
              <button
                key={w.uuid}
                onClick={() => onSelect(w.uuid)}
                className="flex w-full cursor-pointer items-center gap-3 rounded-md border border-input bg-foreground/[0.03] px-3 py-3 text-left transition-colors hover:border-primary/40 hover:bg-primary/10"
              >
                {w.icon ? (
                  <img src={w.icon} alt="" className="h-8 w-8 rounded-md" />
                ) : (
                  <span className="h-8 w-8 rounded-md bg-muted" />
                )}
                <span className="flex-1 font-medium">{w.name}</span>
                <span className="font-data text-xs text-muted-foreground">{w.rdns}</span>
              </button>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
