/** Health check (T0.2 DoD) — returns DB connection status */
import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { withColdStartRetry, type Db } from "../../db/client.js";

export function registerHealthRoutes(app: FastifyInstance, db: Db, version: string): void {
  app.get("/health", async (_req, reply) => {
    let dbStatus = "ok";
    try {
      // Retried once: the first probe after a serverless Postgres resumes may hit 57P03
      await withColdStartRetry(() => db.execute(sql`select 1`));
    } catch {
      dbStatus = "error";
    }
    const healthy = dbStatus === "ok";
    return reply.status(healthy ? 200 : 503).send({
      status: healthy ? "ok" : "degraded",
      db: dbStatus,
      version,
      uptimeSeconds: Math.round(process.uptime()),
    });
  });
}
