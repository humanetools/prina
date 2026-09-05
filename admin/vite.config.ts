import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const coreUrl = process.env.PRINA_CORE_URL ?? "http://localhost:3000";

// On a Windows-mounted working copy (WSL /mnt/c) file-change events reach the watcher
// unreliably, so edits can silently miss HMR. Set VITE_POLL=1 there. Off by default —
// polling costs CPU and native watching is fine on a Linux/macOS checkout.
const watch = process.env.VITE_POLL ? { usePolling: true, interval: 300 } : undefined;

/**
 * OAuth discovery derives the issuer from the request host (oauth.ts issuerOf), so a proxy
 * that rewrites Host to core makes the address the client connected to (:4010) disagree with
 * the advertised issuer (:4002) and MCP clients refuse the connection. xfwd forwards the
 * original host.
 */
const proxy = (target: string) => ({ target, xfwd: true, changeOrigin: false });

// core serves this statically under the /admin/ path (T0.5)
export default defineConfig({
  base: "/admin/",
  plugins: [react()],
  server: {
    watch,
    proxy: {
      // Proxy to the core API during development (PRINA_CORE_URL overrides the port)
      "/api": proxy(coreUrl),
      "/health": proxy(coreUrl),
      // API explorer panel exercises the public delivery plane from the admin origin
      "/delivery": proxy(coreUrl),
      "/openapi.json": proxy(coreUrl),
      // In production core serves this bundle, so window.location.origin is the MCP server too.
      // Proxying /mcp keeps that true in dev — otherwise the connect card hands out a dead URL.
      "/mcp": proxy(coreUrl),
      // OAuth 2.1 discovery + authorize/token live at the root — an MCP client walks these
      // before it can call /mcp at all
      "/.well-known": proxy(coreUrl),
      "/oauth": proxy(coreUrl),
    },
  },
});
