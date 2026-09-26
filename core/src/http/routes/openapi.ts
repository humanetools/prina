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
import { buildApiPaths, type TypeForSpec } from "../openapi/build.js";
import { definitionSchemas } from "../openapi/definition-schema.js";
import { ERROR_RESPONSES } from "../openapi/errors.js";

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

    const schemas: Record<string, unknown> = { ...definitionSchemas(services.registry) };
    const typesForSpec: TypeForSpec[] = [];
    const q = (name: string, description: string, schema: Record<string, unknown> = { type: "string" }) => ({
      name, in: "query", description, schema,
    });
    const wsParam = q("ws", "Workspace slug (default: 'default')");
    const paths: Record<string, unknown> = {
      "/health": { get: { summary: "Health check", responses: { "200": { description: "ok" } } } },
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
      "/delivery/graphql": {
        post: {
          summary: "GraphQL read query over published content (schema generated from this workspace's types)",
          description:
            "Read-only. Per type: `<types>(where, orderBy, limit ≤ 100, offset, locale, taxonomy, taxonomyExact) { total items { … } }`, `<type>(id)`, and single types as " +
            "plain fields. `where` uses the same operators as the REST `filters[...]` (eq ne in notIn contains notContains lt lte gt gte null, ANDed). " +
            "Selections populate relations/media; nesting depth ≤ 6. Every entry has `taxonomies { taxonomy path name attributes entryComponent entryComponentValues }`; roots `taxonomies` and `taxonomy(uid)` serve the trees. Drafts appear only with a valid `draft` token. Fetch the SDL from /delivery/graphql/schema.",
          tags: ["delivery"],
          parameters: [wsParam, q("draft", "Delivery draft token (dt1…) — include unpublished entries")],
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    query: { type: "string", description: "GraphQL document (queries only)" },
                    variables: { type: "object", additionalProperties: true },
                    operationName: { type: "string" },
                  },
                  required: ["query"],
                },
              },
            },
          },
          responses: { "200": { description: "{ data?, errors?[] } — GraphQL response; validation errors are returned in `errors`, not as HTTP 4xx" } },
        },
        get: {
          summary: "GraphQL read query via query string (simple queries)",
          tags: ["delivery"],
          parameters: [wsParam, q("query", "GraphQL document"), q("variables", "JSON-encoded variables"), q("draft", "Delivery draft token")],
          responses: { "200": { description: "{ data?, errors?[] }" } },
        },
      },
      "/delivery/graphql/schema": {
        get: {
          summary: "GraphQL SDL for this workspace (types, filters, query roots)",
          tags: ["delivery"],
          parameters: [wsParam, q("draft", "Delivery draft token")],
          responses: { "200": { description: "text/plain SDL" } },
        },
      },
      "/delivery/taxonomies": {
        get: { summary: "Taxonomies of this workspace", tags: ["delivery"], parameters: [wsParam], responses: { "200": { description: "{ items: [{ uid, name, description, attributeFields }] }" } } },
      },
      "/delivery/taxonomies/{uid}": {
        get: {
          summary: "One taxonomy with its nodes (flat, path-ordered — parents before children)",
          description: "Assemble the tree from `parentId`. `path` is what the `taxonomy` list filter takes. Nodes are public as soon as they exist.",
          tags: ["delivery"],
          parameters: [{ name: "uid", in: "path", required: true, schema: { type: "string" } }, wsParam],
          responses: {
            "200": { description: "{ uid, name, description, attributeFields: [{ name, label, type, multiline }], nodes: [{ id, parentId, name, slug, path, depth, position, attributes, entryComponent }] } — `attributes` are the node's own values for attributeFields; `entryComponent` is the component uid entries under the node fill in" },
            "404": { description: "No such taxonomy" },
          },
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
      typesForSpec.push({ uid: type.uid, name: type.name, valuesRef: ref });
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
              "taxonomy",
              "`<taxonomyUid>:<node.path>` — entries classified under that node, descendants included. Repeat the parameter to AND " +
                "(max 8). Unknown taxonomy/node → 404, malformed → 422.",
            ),
            q("taxonomyExact", "1 = only the node itself, not its descendants"),
            q("taxonomies", "1 = add `taxonomies[]` to each item: { taxonomy, nodeId, name, slug, path, attributes, entryComponent, entryComponentValues } (entryComponentValues resolved when populate=1)"),
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
            { name: "id", in: "path", required: true, description: "Entry id (400 when not a UUID)", schema: { type: "string", format: "uuid" } },
            wsParam,
            q("format", "Response shape", { type: "string", enum: ["json", "html", "head", "jsonld"] }),
            q("populate", "1 = resolve relations/media (json format)"),
            q("taxonomies", "1 = add `taxonomies[]` — the nodes this entry sits in, with the node's attributes and this entry's entry-component values (json format)"),
          ],
          responses: { "200": { description: "json | html fragment | head snippet | JSON-LD" } },
        },
      };
    }

    // Everything declared above is public — say so explicitly (an absent `security` reads as "unknown")
    for (const item of Object.values(paths)) {
      for (const op of Object.values(item as Record<string, Record<string, unknown>>)) op.security ??= [];
    }
    // Management plane — every token-reachable route, from the declarations (21-IMPL-openapi-completion)
    Object.assign(paths, buildApiPaths(app.routeTable, typesForSpec));

    return {
      openapi: "3.1.0",
      info: {
        title: "Prina Core API",
        version,
        description:
          "`/api/*` paths accept two credentials: the admin session cookie (the built-in admin UI) or an " +
          "access token (`Authorization: Bearer pmt_mgmt_…`) issued in the admin console for external systems. " +
          "A token reaches only what it was issued for. Role mode: resource-group scopes (content, schema, " +
          "assets, locales, templates, taxonomies) at read or edit level, with the bound role deciding inside. " +
          "Custom mode: explicit grants — area ▸ item ▸ read|edit (content types, components, entries, publish, " +
          "import — optionally per content type — assets, templates, locales, taxonomies) that are also the " +
          "token's permissions; a token can never exceed its issuer. " +
          "Every `/api/*` operation in this document is reachable with a token and says what it needs in " +
          "`x-prina-access`: `grant` { area, item, level, typed } for custom tokens (`typed` = the grant can be " +
          "narrowed to content types) and `scope` { resource, level } for role tokens; `null` means that token " +
          "mode cannot reach it. Outside its grants a token gets 403 `SCOPE_DENIED` (issue a token with the " +
          "missing grant); 403 `FORBIDDEN` means the grant is there but the permissions behind it are not. " +
          "`/api/*` paths absent from this document — identity, users and roles, token issuance, AI keys, " +
          "workspace settings, the public tunnel — are closed to tokens by design. " +
          "Token requests are pinned to the token's workspace; keep the token server-side (call from your " +
          "backend, not the browser — CORS is deliberately not enabled). `/delivery/*` paths are public and " +
          "serve published content only.",
      },
      servers: [{ url: "/", description: "This instance" }],
      paths,
      components: {
        schemas,
        responses: ERROR_RESPONSES,
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
              "Access token (pmt_mgmt_…) issued in the admin console — for external admin " +
              "pages and integrations. Valid inside what it was issued for (see `x-prina-access` per " +
              "operation); elsewhere 403 SCOPE_DENIED.",
          },
        },
      },
    };
  });
}
