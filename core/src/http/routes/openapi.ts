/**
 * OpenAPI derivation (T1.3 ②) — a consumer of the schema pipeline.
 * Inlines the JSON Schema compiled from content type definitions directly into the document.
 * Schemas are not redefined here (absolute principle 3).
 */
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import type { Services } from "../../commands/context.js";
import { contentTypes } from "../../db/schema/index.js";
import { compileDefinitionToObjectSchema } from "../../content/schema-compiler.js";
import { buildCommandCtx } from "../request-context.js";
import { loadComponentMap } from "../../modules/content-type/repo.js";

export function registerOpenApiRoutes(
  app: FastifyInstance,
  db: Db,
  services: Services,
  version: string,
): void {
  app.get("/openapi.json", async (req) => {
    const ctx = await buildCommandCtx(req, db, services);
    const componentMap = await loadComponentMap(db, ctx.workspaceId);
    const types = await db
      .select()
      .from(contentTypes)
      .where(eq(contentTypes.workspaceId, ctx.workspaceId));

    const schemas: Record<string, unknown> = {};
    const q = (name: string, description: string, schema: Record<string, unknown> = { type: "string" }) => ({
      name, in: "query", description, schema,
    });
    const wsParam = q("ws", "Workspace slug (default: 'default')");
    const paths: Record<string, unknown> = {
      "/health": { get: { summary: "Health check", responses: { "200": { description: "ok" } } } },
      "/api/content-types": {
        get: { summary: "List content types", responses: { "200": { description: "ok" } } },
        post: { summary: "Create a content type", responses: { "201": { description: "created" } } },
      },
      // ---- Public delivery plane (no auth, published content only) ----
      "/delivery/search": {
        get: {
          summary: "Search published content (FTS; semantic fusion when embeddings are configured)",
          tags: ["delivery"],
          parameters: [
            q("q", "Search query (1–500 chars)"),
            q("type", "Restrict to one content type uid"),
            q("locale", "Restrict to one locale"),
            q("limit", "Max hits (default 20, cap 50)", { type: "integer" }),
            wsParam,
          ],
          responses: { "200": { description: "{ query, hits[] }" } },
        },
      },
      "/delivery/sitemap.xml": {
        get: { summary: "Sitemap of SEO-enabled types (locale alternates)", tags: ["delivery"], parameters: [wsParam], responses: { "200": { description: "XML" } } },
      },
      "/delivery/robots.txt": {
        get: { summary: "robots.txt pointing at the sitemap", tags: ["delivery"], parameters: [wsParam], responses: { "200": { description: "text" } } },
      },
      "/delivery/llms.txt": {
        get: { summary: "Content survey for AI agents (GEO)", tags: ["delivery"], parameters: [wsParam], responses: { "200": { description: "text" } } },
      },
    };

    for (const type of types) {
      const valuesSchema = compileDefinitionToObjectSchema(type.definition, {
        registry: services.registry,
        resolveComponent: (uid) => componentMap.get(uid),
      });
      const schemaName = `${type.uid}_values`;
      schemas[schemaName] = valuesSchema;
      const ref = { $ref: `#/components/schemas/${schemaName}` };
      const body = {
        content: {
          "application/json": {
            schema: { type: "object", properties: { values: ref } },
          },
        },
      };
      const contentAuth = { security: [{ session: [] }, { managementToken: [] }], tags: ["content"] };
      paths[`/api/content/${type.uid}`] = {
        get: { summary: `List ${type.name}`, ...contentAuth, responses: { "200": { description: "ok" } } },
        post: {
          summary: `Create ${type.name}`,
          ...contentAuth,
          requestBody: body,
          responses: { "201": { description: "created" } },
        },
      };
      paths[`/api/content/${type.uid}/{id}`] = {
        get: { summary: `Get ${type.name}`, ...contentAuth, responses: { "200": { description: "ok" } } },
        put: {
          summary: `Update ${type.name}`,
          ...contentAuth,
          requestBody: body,
          responses: { "200": { description: "ok" } },
        },
        delete: { summary: `Delete ${type.name}`, ...contentAuth, responses: { "200": { description: "ok" } } },
      };
      paths[`/api/content/${type.uid}/{id}/transition`] = {
        post: {
          summary: `Move ${type.name} through the workflow (e.g. publish)`,
          ...contentAuth,
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { to: { type: "string", description: "Target state (allowed transitions are returned on 409)" } },
                  required: ["to"],
                },
              },
            },
          },
          responses: { "200": { description: "ok" }, "409": { description: "transition not allowed from the current state" } },
        },
      };
      // Public delivery plane for this type
      paths[`/delivery/${type.uid}`] = {
        get: {
          summary: `List published ${type.name} (paged)`,
          tags: ["delivery"],
          parameters: [
            wsParam,
            q("locale", "One locale only"),
            q("page", "1-based page (default 1)", { type: "integer" }),
            q("pageSize", "Rows per page (default 100, cap 100)", { type: "integer" }),
            q("populate", "1 = resolve relations/media to summaries"),
            q(
              "filters[field][$op]",
              "Strapi-style value filters, ANDed. Ops: $eq $ne $in $notIn $contains $notContains $lt $lte $gt $gte $null " +
                "(family-dependent; $in/$notIn take comma lists; relation $eq matches membership on has-many). " +
                "Filterable: text/uid/enum/date/number/boolean/relation fields.",
            ),
          ],
          responses: {
            "200": {
              description: "{ items[] } — totals in x-total-count / x-page / x-page-size headers",
              content: { "application/json": { schema: { type: "object", properties: { items: { type: "array", items: ref } } } } },
            },
          },
        },
      };
      paths[`/delivery/${type.uid}/{id}`] = {
        get: {
          summary: `Get one published ${type.name}`,
          tags: ["delivery"],
          parameters: [
            wsParam,
            q("format", "Response shape", { type: "string", enum: ["json", "html", "head", "jsonld"] }),
            q("populate", "1 = resolve relations/media (json format)"),
          ],
          responses: { "200": { description: "json | html fragment | head snippet | JSON-LD" } },
        },
      };
    }

    return {
      openapi: "3.1.0",
      info: {
        title: "Prina Core API",
        version,
        description:
          "The `/api/content/*` paths accept two credentials: the admin session cookie (the built-in " +
          "admin UI) or a management token (`Authorization: Bearer pmt_mgmt_…`) issued in the MCP console " +
          "for external systems. Token requests are scoped to the token's workspace and role; keep the " +
          "token server-side (call from your backend, not the browser — CORS is deliberately not enabled). " +
          "`/delivery/*` paths are public and serve published content only.",
      },
      paths,
      components: {
        schemas,
        securitySchemes: {
          session: {
            type: "apiKey",
            in: "cookie",
            name: "prina_session",
            description: "Admin session (built-in admin UI)",
          },
          managementToken: {
            type: "http",
            scheme: "bearer",
            description:
              "Role-bound management token (pmt_mgmt_…) from the MCP console — for external " +
              "admin pages and integrations. Valid on /api/content/* only.",
          },
        },
      },
    };
  });
}
