/** Apply migrations manually (CI/ops convenience) — also auto-applied on server startup */
import path from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { loadEnv } from "../src/env.js";
import { createDb } from "../src/db/client.js";

const env = loadEnv();
const { db, pool } = createDb(env.DATABASE_URL);
await migrate(db, { migrationsFolder: path.resolve(process.cwd(), "drizzle") });
await pool.end();
console.log("[migrate] done");
