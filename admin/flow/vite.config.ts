import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Flow SPA (17-IMPL) — the second Vite app in this repo. Source lives under src/ee/flow-app
 * (EE: an OSS build has no src/ee, so scripts/build-flow.mjs skips this build entirely).
 * Core serves the bundle at the ROOT ("/") with assets under /flow-assets/, from
 * admin-dist/flow — hence outDir ../dist/flow beside the admin bundle.
 */
const coreUrl = process.env.PRINA_CORE_URL ?? "http://localhost:3000";
const proxy = (target: string) => ({ target, xfwd: true, changeOrigin: false });

export default defineConfig({
  root: path.resolve(__dirname),
  base: "/flow-assets/",
  plugins: [react()],
  build: {
    outDir: path.resolve(__dirname, "../dist/flow"),
    emptyOutDir: true,
  },
  server: {
    port: 5174,
    proxy: {
      "/delivery": proxy(coreUrl),
      "/api": proxy(coreUrl),
      "/health": proxy(coreUrl),
    },
  },
});
