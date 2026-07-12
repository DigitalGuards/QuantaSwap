import { useEffect } from "react";
import { useLocation } from "react-router-dom";

// Per-route document titles for the SPA. The crawler-facing defaults live in
// index.html; this keeps the tab title (and history entries) in sync as the
// user navigates.
const DEFAULT_TITLE = "QuantaSwap | Cross-chain atomic swaps between ETH and QRL";

const TITLES: Record<string, string> = {
  "/": DEFAULT_TITLE,
  "/how-it-works": "How it works | QuantaSwap",
  "/sandbox": "Sandbox | QuantaSwap",
};

export function RouteMeta() {
  const { pathname } = useLocation();

  useEffect(() => {
    document.title = pathname.startsWith("/swap/")
      ? "Swap status | QuantaSwap"
      : pathname.startsWith("/o/")
        ? "Private swap | QuantaSwap"
        : (TITLES[pathname] ?? DEFAULT_TITLE);
  }, [pathname]);

  return null;
}
