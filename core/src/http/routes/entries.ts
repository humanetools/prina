/** CM REST adapter — command calls only (absolute principle 2) */
import type { FastifyInstance } from "fastify";
import type { Db } from "../../db/client.js";
import type { Services } from "../../commands/context.js";
import { buildCommandCtx } from "../request-context.js";
import {
  entryCreate,
  entryDelete,
  entryDuplicate,
  entryGet,
  entryList,
  entryUpdate,
} from "../../modules/entry/commands.js";
import { entryTransition } from "../../modules/entry/transition-commands.js";
import { entrySetSeo } from "../../modules/entry/seo.js";
import { graphTraverse } from "../../modules/entry/graph-commands.js";
import { contentTypeGet } from "../../modules/content-type/commands.js";
import { loadComponentMap } from "../../modules/content-type/repo.js";
import { collectInverseEdges, populateValuesList } from "../../modules/delivery/populate.js";
import { buildJsonLd } from "../../delivery/jsonld.js";

/** Collects ?filter[sku]=A-1 style queries into a filter object */
function collectFilter(query: Record<string, unknown>): Record<string, string> {
  const filter: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) {
    const m = /^filter\[([^\]]+)\]$/.exec(key);
    if (m && typeof value === "string") filter[m[1]!] = value;
  }
  return filter;
}

export function registerEntryRoutes(
  app: FastifyInstance,
  db: Db,
  services: Services,
): void {
  const ctx = (req: Parameters<typeof buildCommandCtx>[0]) =>
    buildCommandCtx(req, db, services);

  app.get("/api/content/:typeUid", async (req) => {
    const { typeUid } = req.params as { typeUid: string };
    const query = req.query as Record<string, unknown>;
    return entryList.run(
      { ...query, typeUid, filter: collectFilter(query) },
      await ctx(req),
    );
  });

  app.post("/api/content/:typeUid", async (req, reply) => {
    const { typeUid } = req.params as { typeUid: string };
    const result = await entryCreate.run(
      { ...(req.body as object), typeUid },
      await ctx(req),
    );
    return reply.status(201).send(result);
  });

  app.get("/api/content/:typeUid/:id", async (req) => {
    const params = req.params as { typeUid: string; id: string };
    return entryGet.run(params, await ctx(req));
  });

  app.put("/api/content/:typeUid/:id", async (req) => {
    const params = req.params as { typeUid: string; id: string };
    const body = req.body as { values?: Record<string, unknown> };
    return entryUpdate.run(
      { ...params, values: body?.values ?? (body as Record<string, unknown>) },
      await ctx(req),
    );
  });

  app.delete("/api/content/:typeUid/:id", async (req) => {
    const params = req.params as { typeUid: string; id: string };
    return entryDelete.run(params, await ctx(req));
  });

  // Entry SEO record (§0.11) — non-field metadata, full-replace (taxonomy-attach pattern)
  app.put("/api/content/:typeUid/:id/seo", async (req) => {
    const params = req.params as { typeUid: string; id: string };
    const body = req.body as { seo?: unknown };
    return entrySetSeo.run({ ...params, seo: body?.seo ?? null }, await ctx(req));
  });

  app.post("/api/content/:typeUid/:id/duplicate", async (req, reply) => {
    const params = req.params as { typeUid: string; id: string };
    return reply.status(201).send(await entryDuplicate.run(params, await ctx(req)));
  });

  // Multi-hop graph traversal (T9.2) — ?path=series.brand chain or ?depth=N expansion
  app.get("/api/content/:typeUid/:id/traverse", async (req) => {
    const params = req.params as { typeUid: string; id: string };
    const q = req.query as { path?: string; depth?: string; published?: string };
    return graphTraverse.run(
      {
        ...params,
        path: q.path ? q.path.split(".") : undefined,
        depth: q.depth ? Number(q.depth) : undefined,
        publishedOnly: q.published === "1",
      },
      await ctx(req),
    );
  });

  // JSON-LD preview (T9.1) — includes drafts, for the View snippet in the CTB Predicate tab
  app.get("/api/content/:typeUid/:id/jsonld-preview", async (req) => {
    const params = req.params as { typeUid: string; id: string };
    const cmdCtx = await ctx(req);
    const detail = await entryGet.run(params, cmdCtx);
    const type = await contentTypeGet.run({ uid: params.typeUid }, cmdCtx);
    const dctx = {
      db,
      services,
      workspace: { id: cmdCtx.workspaceId, slug: "", settings: {} },
      includeDraft: true, // preview — also shows draft relation targets
    };
    const [populated] = await populateValuesList(dctx, type.definition, [
      detail.effectiveValues as Record<string, unknown>,
    ]);
    const componentDefs = await loadComponentMap(db, cmdCtx.workspaceId);
    const inverseEdges = await collectInverseEdges(dctx, detail.entry.id);
    const jsonld = buildJsonLd({
      inverseEdges,
      schemaOrgType: type.schemaOrgType,
      schemaOrgSecondary: type.schemaOrgSecondary,
      definition: type.definition,
      entryId: detail.entry.id,
      populatedValues: populated!,
      registry: services.registry,
      componentDefs,
    });
    return { jsonld, status: detail.entry.status };
  });

  app.post("/api/content/:typeUid/:id/transition", async (req) => {
    const params = req.params as { typeUid: string; id: string };
    const body = req.body as { to?: string };
    return entryTransition.run({ ...params, to: body?.to }, await ctx(req));
  });

  // Version history/restore routes are EE (src/ee/routes.ts) — recording is still done by core (IMPL-ee-boundary)
}
