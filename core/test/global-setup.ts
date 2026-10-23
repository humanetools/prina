/** Global test setup: start a temporary embedded Postgres + apply migrations */
import EmbeddedPostgres from "embedded-postgres";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb } from "../src/db/client.js";

export default async function setup(): Promise<() => Promise<void>> {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "prina-test-pg-"));
  const port = 54_000 + Math.floor(Math.random() * 1000);
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "postgres",
    password: "postgres",
    port,
    persistent: false,
  });
  await pg.initialise();
  await pg.start();
  // ⚠ embedded-postgres's dependency async-exit-hook calls process.exit(0) in a
  // beforeExit hook, swallowing the failure exitCode(1) set by vitest — the reason
  // CI stays green even when tests fail (observed 2026-08-14). Wrap exit so that a
  // pending exitCode takes precedence over exit(0) and is preserved.
  // (Removing the listener is not an option — it breaks embedded-postgres's own cleanup hook)
  const origExit = process.exit.bind(process);
  process.exit = ((code?: number) =>
    origExit(
      (code === 0 || code === undefined) && typeof process.exitCode === "number"
        ? process.exitCode
        : code,
    )) as typeof process.exit;
  await pg.createDatabase("prina_test");

  const url = `postgres://postgres:postgres@localhost:${port}/prina_test`;
  process.env.TEST_DATABASE_URL = url;

  const { db, pool } = createDb(url);
  await migrate(db, { migrationsFolder: path.resolve(process.cwd(), "drizzle") });
  await pool.end();

  return async () => {
    await pg.stop();
    rmSync(dataDir, { recursive: true, force: true });
  };
}
