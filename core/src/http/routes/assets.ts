/** DAM REST adapter (T4.1~T4.4) — command calls + local-adapter-only upload/serving routes */
import type { FastifyInstance } from "fastify";
import type { Db } from "../../db/client.js";
import type { Services } from "../../commands/context.js";
import { buildCommandCtx } from "../request-context.js";
import { verifyLocalUpload } from "../../storage/index.js";
import {
  assetAnalyze,
  assetConfirmUpload,
  assetDelete,
  assetFolders,
  assetGet,
  assetList,
  assetRequestUpload,
  assetUpdate,
} from "../../modules/asset/commands.js";

export function registerAssetRoutes(
  app: FastifyInstance,
  db: Db,
  services: Services,
): void {
  const ctx = (req: Parameters<typeof buildCommandCtx>[0]) =>
    buildCommandCtx(req, db, services);

  app.post("/api/assets/uploads", async (req, reply) =>
    reply.status(201).send(await assetRequestUpload.run(req.body, await ctx(req))),
  );
  app.post("/api/assets/:id/confirm", async (req) => {
    const { id } = req.params as { id: string };
    return assetConfirmUpload.run({ id }, await ctx(req));
  });
  // Contrast analysis backfill (§0.11 4b) — for assets uploaded before the feature
  app.post("/api/assets/:id/analyze", async (req) => {
    const { id } = req.params as { id: string };
    return assetAnalyze.run({ id }, await ctx(req));
  });
  app.get("/api/assets", async (req) => assetList.run(req.query, await ctx(req)));
  app.get("/api/assets/folders", async (req) => assetFolders.run({}, await ctx(req)));
  app.get("/api/assets/:id", async (req) => {
    const { id } = req.params as { id: string };
    return assetGet.run({ id }, await ctx(req));
  });
  // Editable asset metadata — alt text (a11y)
  app.patch("/api/assets/:id", async (req) => {
    const { id } = req.params as { id: string };
    return assetUpdate.run({ ...(req.body as object), id }, await ctx(req));
  });
  app.delete("/api/assets/:id", async (req) => {
    const { id } = req.params as { id: string };
    return assetDelete.run({ id }, await ctx(req));
  });

  // ── Local adapter only (dev/demo environments without S3) ─────────────────────────
  if (services.storage.adapter.kind === "local") {
    // presigned PUT target — store after verifying the HMAC signature
    app.put("/api/assets/local-upload", async (req, reply) => {
      const q = req.query as { key?: string; expires?: string; sig?: string };
      if (
        !q.key || !q.expires || !q.sig ||
        !verifyLocalUpload(q.key, Number(q.expires), q.sig)
      ) {
        return reply.status(403).send({
          error: { code: "FORBIDDEN", message: "Upload signature is not valid", details: null },
        });
      }
      const body = req.body as Buffer;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        return reply.status(422).send({
          error: { code: "VALIDATION_ERROR", message: "File body is empty", details: null },
        });
      }
      await services.storage.adapter.put(q.key, body);
      return { ok: true, size: body.length };
    });

    // Serve originals (renditions only with an S3+imgproxy setup)
    app.get("/api/assets/raw/:key", async (req, reply) => {
      const { key } = req.params as { key: string };
      const buf = await services.storage.adapter.read(decodeURIComponent(key));
      if (!buf) {
        return reply.status(404).send({
          error: { code: "NOT_FOUND", message: "File not found", details: null },
        });
      }
      return reply.header("cache-control", "private, max-age=3600").send(buf);
    });
  }
}
