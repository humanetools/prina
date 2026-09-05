import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema/index.js";

export type Db = ReturnType<typeof createDb>["db"];

export function createDb(databaseUrl: string) {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  // Without an "error" listener, an idle client dropping its socket is an unhandled
  // event that crashes the process. Serverless Postgres (e.g. Neon) closes idle
  // connections whenever it suspends compute, so this is a routine path in hosted
  // deployments; the pool discards the client and dials a fresh one on next use.
  // console.error because the app logger is created later than the pool.
  pool.on("error", (err) => {
    console.error("[prina-core] idle postgres client error (connection discarded):", err.message);
  });
  const db = drizzle(pool, { schema });
  return { pool, db };
}

/** SQLSTATE 57P03 (cannot_connect_now) — the server is still starting up */
const PG_CANNOT_CONNECT_NOW = "57P03";
const RETRYABLE_SOCKET_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT"]);
const COLD_START_RETRY_DELAY_MS = 1_000;

/** True for the error shapes a cold-starting Postgres produces on its first contact */
export function isColdStartError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  return code === PG_CANNOT_CONNECT_NOW || (typeof code === "string" && RETRYABLE_SOCKET_CODES.has(code));
}

/**
 * Run `fn`, retrying it exactly once after a short pause when the first attempt fails
 * with a cold-start signature (57P03 or a socket error). Any other error rethrows as is.
 *
 * Apply only at request entry points (health probe, session lookup): the first request
 * after a serverless database resumes wakes it there, and every later query in the same
 * request already sees a live server. Not for arbitrary queries or transactions —
 * retrying inside a transaction would replay partial work.
 */
export async function withColdStartRetry<T>(
  fn: () => Promise<T>,
  delayMs: number = COLD_START_RETRY_DELAY_MS,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!isColdStartError(err)) throw err;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return fn();
  }
}
