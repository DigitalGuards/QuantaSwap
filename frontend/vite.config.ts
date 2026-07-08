import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Dev-only RPC proxies: the QRL node has no CORS headers and the page is
// http://localhost, so both legs are reached same-origin through Vite.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(path.dirname(fileURLToPath(import.meta.url)), "src") },
  },
  server: {
    proxy: {
      "/rpc/qrl": {
        target: "http://REDACTED:8545",
        changeOrigin: true,
        rewrite: () => "/",
      },
      "/rpc/sepolia": {
        target: "https://ethereum-sepolia-rpc.publicnode.com",
        changeOrigin: true,
        rewrite: () => "/",
      },
    },
  },
});
