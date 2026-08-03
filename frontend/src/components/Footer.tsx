import { Link } from "react-router";
import { GITHUB_URL } from "@/config";

export function Footer() {
  return (
    <footer className="mt-auto border-t border-border/60">
      <div className="mx-auto flex max-w-5xl flex-col items-center justify-between gap-3 px-4 py-6 text-xs text-muted-foreground sm:flex-row">
        <span>QuantaSwap: trustless atomic swaps between ETH and QRL 2.0</span>
        <div className="flex items-center gap-6">
          <a href="https://qrlwallet.com" target="_blank" rel="noreferrer" className="hover:text-foreground">
            MyQRLWallet
          </a>
          <a href="https://quantapool.com" target="_blank" rel="noreferrer" className="hover:text-foreground">
            QuantaPool
          </a>
          <a href="https://zondscan.com" target="_blank" rel="noreferrer" className="hover:text-foreground">
            Explorer
          </a>
          <a href={GITHUB_URL} target="_blank" rel="noreferrer" className="hover:text-foreground">
            GitHub
          </a>
          <Link to="/legal" className="hover:text-foreground">
            Legal
          </Link>
        </div>
      </div>
    </footer>
  );
}
