// Builds the Flow SPA (17-IMPL) when its EE source exists. The OSS release rebuilds the
// admin after physically removing src/ee — then there is no flow app and nothing to build,
// so the OSS image ships no Flow bundle (core keeps "/" at 404).
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, "../src/ee/flow-app");
if (!existsSync(src)) {
  console.log("[build-flow] src/ee/flow-app absent (OSS build) — skipping the Flow SPA");
  process.exit(0);
}
const r = spawnSync("npx", ["vite", "build", "--config", "flow/vite.config.ts"], {
  cwd: path.resolve(here, ".."),
  stdio: "inherit",
});
process.exit(r.status ?? 1);
