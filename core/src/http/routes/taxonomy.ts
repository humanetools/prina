/** Taxonomy REST adapter (T2.5) — command calls only */
import type { FastifyInstance } from "fastify";
import type { Db } from "../../db/client.js";
import type { Services } from "../../commands/context.js";
import { buildCommandCtx } from "../request-context.js";
import {
  taxonomyCreate,
  taxonomyList,
  taxonomyNodeCreate,
  taxonomyNodeDelete,
  taxonomyNodeMove,
  taxonomyTree,
} from "../../modules/taxonomy/commands.js";
import {
  entryListByDocument,
  entrySetTaxonomies,
} from "../../modules/entry/document-commands.js";

export function registerTaxonomyRoutes(
  app: FastifyInstance,
  db: Db,
  services: Services,
): void {
  const ctx = (req: Parameters<typeof buildCommandCtx>[0]) =>
    buildCommandCtx(req, db, services);

  app.get("/api/taxonomies", async (req) => taxonomyList.run({}, await ctx(req)));
  app.post("/api/taxonomies", async (req, reply) =>
    reply.status(201).send(await taxonomyCreate.run(req.body, await ctx(req))),
  );
  app.get("/api/taxonomies/:taxonomyUid/tree", async (req) => {
    const { taxonomyUid } = req.params as { taxonomyUid: string };
    return taxonomyTree.run({ taxonomyUid }, await ctx(req));
  });
  app.post("/api/taxonomies/:taxonomyUid/nodes", async (req, reply) => {
    const { taxonomyUid } = req.params as { taxonomyUid: string };
    return reply
      .status(201)
      .send(await taxonomyNodeCreate.run({ ...(req.body as object), taxonomyUid }, await ctx(req)));
  });
  app.put("/api/taxonomy-nodes/:nodeId/move", async (req) => {
    const { nodeId } = req.params as { nodeId: string };
    return taxonomyNodeMove.run({ ...(req.body as object), nodeId }, await ctx(req));
  });
  app.delete("/api/taxonomy-nodes/:nodeId", async (req) => {
    const { nodeId } = req.params as { nodeId: string };
    return taxonomyNodeDelete.run({ nodeId }, await ctx(req));
  });

  // Entry side (i18n document lookup + taxonomy attach)
  app.get("/api/content/:typeUid/document/:documentId", async (req) => {
    const params = req.params as { typeUid: string; documentId: string };
    return entryListByDocument.run(params, await ctx(req));
  });
  app.put("/api/content/:typeUid/:id/taxonomies", async (req) => {
    const params = req.params as { typeUid: string; id: string };
    return entrySetTaxonomies.run({ ...(req.body as object), ...params }, await ctx(req));
  });
}
