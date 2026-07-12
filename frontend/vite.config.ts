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
      "/api": {
        target: "http://127.0.0.1:8091",
        changeOrigin: true,
      },
      "/rpc/qrl": {
        target: "https://qrlwallet.com",
        changeOrigin: true,
        rewrite: () => "/api/qrl-rpc/testnet",
      },
      // Must precede /rpc/sepolia: Vite proxy keys prefix-match in order.
      "/rpc/sepolia-logs": {
        target: "https://rpc.sepolia.ethpandaops.io",
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
