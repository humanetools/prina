/** CTB REST adapter — command calls only (no UI-specific logic, absolute principle 2) */
import type { FastifyInstance } from "fastify";
import type { Db } from "../../db/client.js";
import type { Services } from "../../commands/context.js";
import { buildCommandCtx } from "../request-context.js";
import { inverseOf, listProperties, listTypes, validateProperties } from "../../delivery/schema-vocab.js";
import { buildJsonLd } from "../../delivery/jsonld.js";
import { sampleValues } from "../../delivery/jsonld-sample.js";
import { loadComponentMap } from "../../modules/content-type/repo.js";
import {
  contentTypeCreate,
  contentTypeDelete,
  contentTypeGet,
  contentTypeList,
  contentTypeUpdate,
} from "../../modules/content-type/commands.js";
import {
  componentCreate,
  componentDelete,
  componentList,
  componentUpdate,
} from "../../modules/content-type/component-commands.js";

export function registerContentTypeRoutes(
  app: FastifyInstance,
  db: Db,
  services: Services,
): void {
  const ctx = (req: Parameters<typeof buildCommandCtx>[0]) =>
    buildCommandCtx(req, db, services);

  app.get("/api/content-types", async (req) =>
    contentTypeList.run({}, await ctx(req)),
  );
  app.post("/api/content-types", async (req, reply) => {
    const result = await contentTypeCreate.run(req.body, await ctx(req));
    return reply.status(201).send(result);
  });
  app.get("/api/content-types/:uid", async (req) => {
    const { uid } = req.params as { uid: string };
    return contentTypeGet.run({ uid }, await ctx(req));
  });
  app.put("/api/content-types/:uid", async (req) => {
    const { uid } = req.params as { uid: string };
    return contentTypeUpdate.run({ ...(req.body as object), uid }, await ctx(req));
  });
  app.delete("/api/content-types/:uid", async (req) => {
    const { uid } = req.params as { uid: string };
    return contentTypeDelete.run({ uid }, await ctx(req));
  });

  app.get("/api/components", async (req) => componentList.run({}, await ctx(req)));

  // JSON-LD sample built from the type definition alone (View snippet when there are no entries)
  app.get("/api/content-types/:uid/jsonld-sample", async (req) => {
    const { uid } = req.params as { uid: string };
    const cmdCtx = await ctx(req);
    const type = await contentTypeGet.run({ uid }, cmdCtx);
    const componentDefs = await loadComponentMap(db, cmdCtx.workspaceId);
    const jsonld = buildJsonLd({
      schemaOrgType: type.schemaOrgType,
      schemaOrgSecondary: type.schemaOrgSecondary,
      definition: type.definition,
      entryId: "00000000-0000-0000-0000-000000000000",
      populatedValues: sampleValues(type.definition, componentDefs),
      registry: services.registry,
      componentDefs,
    });
    return { jsonld };
  });

  // Full schema.org class list (combobox search)
  app.get("/api/schema-org/types", async (_req, reply) => {
    return reply.header("cache-control", "private, max-age=3600").send({ types: listTypes() });
  });

  // Full schema.org property list (predicate autocomplete)
  app.get("/api/schema-org/properties", async (_req, reply) => {
    return reply
      .header("cache-control", "private, max-age=3600")
      .send({ properties: listProperties() });
  });

  // Standard inverse-predicate lookup (default suggestion for the inverse toggle)
  app.get("/api/schema-org/inverse", async (req) => {
    const q = req.query as { prop?: string };
    return { inverse: q.prop ? inverseOf(q.prop) : null };
  });

  // schema.org property validation (T9.1 — Field→property status in the CTB Predicate tab)
  app.get("/api/schema-org/validate", async (req) => {
    const q = req.query as { types?: string; props?: string };
    const types = (q.types ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const props = (q.props ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    return { valid: validateProperties(props, types) };
  });
  app.post("/api/components", async (req, reply) => {
    const result = await componentCreate.run(req.body, await ctx(req));
    return reply.status(201).send(result);
  });
  app.put("/api/components/:uid", async (req) => {
    const { uid } = req.params as { uid: string };
    return componentUpdate.run({ ...(req.body as object), uid }, await ctx(req));
  });
  app.delete("/api/components/:uid", async (req) => {
    const { uid } = req.params as { uid: string };
    return componentDelete.run({ uid }, await ctx(req));
  });
}
