import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "@/App";
// Self-hosted variable fonts (bundled by Vite): Sora = display,
// Instrument Sans = body, JetBrains Mono = data (addresses/amounts/hashes).
// Imported here, not in index.css, so Vite rewrites the woff2 asset URLs.
import "@fontsource-variable/sora/index.css";
import "@fontsource-variable/instrument-sans/index.css";
import "@fontsource-variable/jetbrains-mono/index.css";
import "./index.css";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("missing #root");

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>
);
