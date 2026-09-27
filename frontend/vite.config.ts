import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Dev-only RPC proxies: the QRL node has no CORS headers and the page is
// http://localhost, so both legs are reached same-origin through Vite.
// This release is built under a sub-path so it can be served beside the
// current one on the same origin. Browser swap state is scoped to the origin
// and namespaced on both HTLC addresses, so this build reads exactly the
// records the HTLCv2 deployment wrote.
const basePath = (() => {
  const raw = process.env["VITE_BASE_PATH"];
  if (raw === undefined || raw === "" || raw === "/") return "/";
  if (!/^\/[A-Za-z0-9][A-Za-z0-9._~-]*(\/[A-Za-z0-9._~-]+)*\/?$/.test(raw)) {
    throw new Error("VITE_BASE_PATH must be an absolute path, for example /v2/");
  }
  return raw.endsWith("/") ? raw : `${raw}/`;
})();

export default defineConfig({
  base: basePath,
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
        configure: (proxy) => {
          // This server-side development proxy owns its upstream request.
          proxy.on("proxyReq", (request) => request.removeHeader("origin"));
        },
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
