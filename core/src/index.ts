/** Entry point: env validation → migrations → seed → server start */
import path from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { loadEnv } from "./env.js";
import { createDb } from "./db/client.js";
import { bootstrap } from "./bootstrap.js";
import { buildApp } from "./app.js";
import { setEmbedSwitchHook } from "./modules/ai/routing.js";
import { vectorCapabilityReadOnly } from "./modules/delivery/semantic.js";
import { sql as drizzleSql } from "drizzle-orm";
import { loadEe } from "./ee-loader.js";
import { startEmbeddingWorker } from "./modules/delivery/semantic.js";
import { startLicenseWorker } from "./modules/license/service.js";
import { createTunnelRuntime, resumeTunnel } from "./modules/tunnel/service.js";
import { CORE_VERSION } from "./version.js";

async function main(): Promise<void> {
  const env = loadEnv();
  const { db, pool } = createDb(env.DATABASE_URL);

  // Self-hosted product: container startup = apply migrations (§3 install experience)
  await migrate(db, {
    migrationsFolder: path.resolve(process.cwd(), "drizzle"),
  });
  // EE module (IMPL-ee-boundary) — null in OSS builds (no src/ee)
  const ee = await loadEe();
  await bootstrap(db, ee?.workflowPreset);

  // 11-IMPL: an embedding-provider switch invalidates every stored vector (spaces differ) —
  // flip core search embeddings to pending and let EE re-derive chatbot knowledge.
  setEmbedSwitchHook(async (hookDb) => {
    if (await vectorCapabilityReadOnly(hookDb)) {
      await hookDb.execute(
        drizzleSql`UPDATE entry_embeddings SET status = 'pending', updated_at = now()`,
      );
    }
    await ee?.onEmbeddingProviderSwitch?.(hookDb);
  });

  // Public tunnel (IMPL-public-tunnel) — cloudflared supervision + boot-time reconnect
  const tunnelRuntime = createTunnelRuntime({
    bin: env.TUNNEL_CLOUDFLARED_BIN,
    log: { info: (m) => console.log(m), error: (m) => console.error(m) },
  });

  const app = buildApp({
    env,
    db,
    ee,
    tunnel: { runtime: tunnelRuntime, serviceUrl: env.TUNNEL_SERVICE_URL, localPort: env.PORT },
  });
  await resumeTunnel(db, tunnelRuntime);
  // Semantic embedding worker (T9.3) — each tick is a no-op without pgvector/BYOK
  const stopEmbedWorker = startEmbeddingWorker(db);
  // License worker (T8.2) — once at startup + every 12h: verification/version reporting (no blocking, surface only)
  const stopLicenseWorker = startLicenseWorker(db, env, CORE_VERSION);
  const shutdown = async () => {
    tunnelRuntime.stop();
    stopEmbedWorker();
    stopLicenseWorker();
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await app.listen({ host: env.HOST, port: env.PORT });
}

main().catch((err) => {
  console.error("[prina-core] Failed to start:", err);
  process.exit(1);
});
