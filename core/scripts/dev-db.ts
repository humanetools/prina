/**
 * Local Postgres for development (for environments without Docker) — uses embedded-postgres.
 * Data persists in ~/.prina/devdb (kept in the Linux home to avoid WSL drvfs permission issues).
 * On Docker-capable environments, prina-deploy's compose is the standard (T0.3).
 */
import EmbeddedPostgres from "embedded-postgres";
import os from "node:os";
import path from "node:path";

const PORT = Number(process.env.DEV_DB_PORT ?? 5433);
const dataDir = path.join(os.homedir(), ".prina", "devdb");

async function main(): Promise<void> {
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "postgres",
    password: "postgres",
    port: PORT,
    persistent: true,
  });

  const fs = await import("node:fs");
  if (!fs.existsSync(path.join(dataDir, "PG_VERSION"))) {
    console.log(`[dev-db] initdb: ${dataDir}`);
    await pg.initialise();
  }
  await pg.start();
  try {
    await pg.createDatabase("prina");
  } catch {
    /* already exists */
  }
  console.log(`[dev-db] ready: postgres://postgres:postgres@localhost:${PORT}/prina`);
  console.log("[dev-db] stop with Ctrl+C");

  const stop = async () => {
    await pg.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  // Keep the process alive
  await new Promise(() => {});
}

main().catch((err) => {
  console.error("[dev-db] failed:", err);
  process.exit(1);
});
