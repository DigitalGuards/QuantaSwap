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
 * discovered; a click runs the matching connect path. Ported from QuantaPool.
 *
 * MyQRLWallet announces once per transport (browser extension and connect
 * relay), so the hook folds the pair into a single row. Clicking that row
 * uses the extension when it is installed, and the "Use phone or desktop app"
 * button under it always starts relay pairing.
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
            Compatible QRL wallets are detected automatically. Portable V2 orders support
            MyQRLWallet Extension and the MyQRLWallet web wallet.
          </p>
        </CardHeader>
        <CardContent className="space-y-2">
          {wallets.length === 0 ? (
            <p className="rounded-md border border-border bg-muted/40 p-3 text-center text-sm text-muted-foreground">
              No QRL wallets detected. Install MyQRLWallet Extension or connect the MyQRLWallet
              web wallet.
            </p>
          ) : (
            wallets.map((w) => {
              // The merged MyQRLWallet row offers relay pairing as a second,
              // separately focusable button when the extension holds the
              // primary click.
              const relayUuid = w.kind === "myqrlwallet" ? w.secondaryUuid : null;
              const relayLabel = w.kind === "myqrlwallet" ? w.secondaryLabel : null;
              return (
                <div key={w.uuid} className="space-y-1">
                  <button
                    onClick={() => onSelect(w.uuid)}
                    className="flex w-full cursor-pointer items-center gap-3 rounded-md border border-input bg-foreground/[0.03] px-3 py-3 text-left transition-colors hover:border-primary/40 hover:bg-primary/10"
                  >
                    {w.icon ? (
                      <img src={w.icon} alt="" className="h-8 w-8 shrink-0 rounded-md" />
                    ) : (
                      <span className="h-8 w-8 shrink-0 rounded-md bg-muted" />
                    )}
                    <span className="flex-1 font-medium">{w.name}</span>
                    {w.kind === "myqrlwallet" ? (
                      <span className="text-xs text-muted-foreground">{w.primaryLabel}</span>
                    ) : (
                      <span className="font-data text-xs text-muted-foreground">{w.rdns}</span>
                    )}
                  </button>
                  {relayUuid && relayLabel ? (
                    <button
                      onClick={() => onSelect(relayUuid)}
                      aria-label={`${relayLabel} to connect ${w.name}`}
                      className="cursor-pointer rounded-sm pl-11 text-left text-xs text-primary underline underline-offset-4 hover:text-primary/80"
                    >
                      {relayLabel}
                    </button>
                  ) : null}
                </div>
              );
            })
          )}
        </CardContent>
      </Card>
    </div>
  );
}
