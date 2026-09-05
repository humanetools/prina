/**
 * Delivery public plane (T5.2) — no session auth. published only (+draft token).
 * ① GET /delivery/:type/:id            → JSON
 * ② GET /delivery/:type/:id?format=html → SSR fragment (CSS scoping, versioned URLs)
 *    (&embed=1 → JSON for embed.js {html,css,js,ga})
 * ③ GET /delivery/embed.js             → Shadow DOM render snippet
 */
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import type { Services } from "../../commands/context.js";
import { assets, workspaces } from "../../db/schema/index.js";
import { embedJsSource } from "../../delivery/runtime.js";
import { verifyDraftToken } from "../../modules/delivery/token.js";
import {
  deliveryGet,
  deliveryList,
  getDeliveryType,
  getTemplateAsset,
  renderDelivery,
  resolveWorkspace,
  type DeliveryCtx,
} from "../../modules/delivery/service.js";
import { collectInverseEdges, populateValuesList } from "../../modules/delivery/populate.js";
import { parseFilterParams } from "../../modules/delivery/filters.js";
import { buildJsonLd, canBuildJsonLd } from "../../delivery/jsonld.js";
import {
  buildHeadTags,
  displayValueOf,
  resolveEntryUrl,
  seoTypeOptions,
  serializeMetaLinks,
  workspaceSeoSettings,
  type SeoContext,
} from "../../delivery/seo.js";
import { loadComponentMap } from "../../modules/content-type/repo.js";
import {
  buildLlmsTxt,
  buildRobotsTxt,
  buildSitemapXml,
  listPublishedForSurfaces,
} from "../../modules/delivery/surfaces.js";
import { searchPublished } from "../../modules/delivery/search.js";

const IMMUTABLE = "public, max-age=31536000, immutable";
/**
 * Ids reach the public plane straight from the URL, without the zod input schema that
 * guards the command plane. Postgres rejects a malformed uuid with 22P02, which surfaced
 * as a 500 on the customer's frontend (found while testing the API explorer, 2026-08-24).
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const badIdReply = (what: string) => ({
  error: { code: "VALIDATION_ERROR", message: `${what} id must be a uuid`, details: null },
});
/** Same exposure for numeric query params: NaN/Infinity/fractions ride into LIMIT/OFFSET as 500s */
const posInt = (v: unknown, fallback: number): number => {
  const n = Number(v);
  return Number.isSafeInteger(n) && n >= 1 ? n : fallback;
};
/** GEO/SEO surfaces regenerate per request — lean on CDN caching */
const SURFACE_CACHE = "public, max-age=300, s-maxage=3600";

export function registerDeliveryRoutes(
  app: FastifyInstance,
  db: Db,
  services: Services,
): void {
  // embed.js is fetched from customer domains, so only the delivery plane opens CORS
  app.addHook("onSend", (req, reply, payload, done) => {
    if (req.url.startsWith("/delivery/")) {
      reply.header("access-control-allow-origin", "*");
    }
    done(null, payload);
  });
  async function buildCtx(query: Record<string, unknown>): Promise<DeliveryCtx> {
    const slug = typeof query.ws === "string" && query.ws ? query.ws : "default";
    const workspace = await resolveWorkspace(db, slug);
    const draft = typeof query.draft === "string" ? query.draft : null;
    const includeDraft = draft ? await verifyDraftToken(db, draft, slug) : false;
    return { db, services, workspace, includeDraft };
  }

  app.get("/delivery/embed.js", async (_req, reply) =>
    reply
      .header("content-type", "application/javascript; charset=utf-8")
      .header("cache-control", "public, max-age=3600")
      .send(embedJsSource()),
  );

  // Version-pinned template assets — CDN cache (T5.2)
  app.get("/delivery/templates/:typeUid/:versionTag/style.css", async (req, reply) => {
    const { typeUid, versionTag } = req.params as { typeUid: string; versionTag: string };
    const ctx = await buildCtx(req.query as Record<string, unknown>);
    const css = await getTemplateAsset(ctx, typeUid, parseVersion(versionTag), "css");
    return reply
      .header("content-type", "text/css; charset=utf-8")
      .header("cache-control", IMMUTABLE)
      .send(css);
  });
  app.get("/delivery/templates/:typeUid/:versionTag/script.js", async (req, reply) => {
    const { typeUid, versionTag } = req.params as { typeUid: string; versionTag: string };
    const ctx = await buildCtx(req.query as Record<string, unknown>);
    const js = await getTemplateAsset(ctx, typeUid, parseVersion(versionTag), "js");
    return reply
      .header("content-type", "application/javascript; charset=utf-8")
      .header("cache-control", IMMUTABLE)
      .send(js);
  });

  // GEO/SEO surfaces (§0.11 Phase 2) — published content only; draft tokens are ignored on purpose
  async function surfaceCtx(query: Record<string, unknown>): Promise<DeliveryCtx> {
    const ctx = await buildCtx(query);
    return { ...ctx, includeDraft: false };
  }

  // Published-content search for frontends (todo §0.18) — FTS always, semantic fused when
  // embeddings are configured (silent FTS fallback). Same engine the MCP delivery plane uses.
  app.get("/delivery/search", async (req, reply) => {
    const q = req.query as Record<string, unknown>;
    const query = String(q.q ?? "").trim();
    if (!query || query.length > 500) {
      return reply.status(400).send({
        error: { code: "VALIDATION_ERROR", message: "q (1–500 chars) is required" },
      });
    }
    const dctx = await surfaceCtx(q);
    const hits = await searchPublished(db, dctx.workspace.id, query, {
      typeUid: q.type ? String(q.type) : undefined,
      locale: q.locale ? String(q.locale) : undefined,
      limit: q.limit === undefined ? undefined : posInt(q.limit, 20),
    });
    return reply.header("cache-control", "no-store").send({ query, hits });
  });

  app.get("/delivery/sitemap.xml", async (req, reply) => {
    const ctx = await surfaceCtx(req.query as Record<string, unknown>);
    const types = await listPublishedForSurfaces(ctx);
    return reply
      .header("content-type", "application/xml; charset=utf-8")
      .header("cache-control", SURFACE_CACHE)
      .send(buildSitemapXml(types));
  });

  app.get("/delivery/robots.txt", async (req, reply) => {
    const ctx = await surfaceCtx(req.query as Record<string, unknown>);
    const seo = workspaceSeoSettings(ctx.workspace.settings);
    return reply
      .header("content-type", "text/plain; charset=utf-8")
      .header("cache-control", SURFACE_CACHE)
      .send(buildRobotsTxt(ctx, requestOrigin(req), seo?.robots?.extraDisallow ?? []));
  });

  app.get("/delivery/llms.txt", async (req, reply) => {
    const ctx = await surfaceCtx(req.query as Record<string, unknown>);
    const [ws] = await db
      .select({ name: workspaces.name })
      .from(workspaces)
      .where(eq(workspaces.id, ctx.workspace.id))
      .limit(1);
    const types = await listPublishedForSurfaces(ctx);
    return reply
      .header("content-type", "text/plain; charset=utf-8")
      .header("cache-control", SURFACE_CACHE)
      .send(buildLlmsTxt(ctx, requestOrigin(req), ws?.name ?? ctx.workspace.slug, types));
  });

  // Public asset access (images of published content) — presigned redirect on S3, stream on local
  app.get("/delivery/assets/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) return reply.status(400).send(badIdReply("Asset"));
    const [asset] = await db.select().from(assets).where(eq(assets.id, id)).limit(1);
    if (!asset) {
      return reply.status(404).send({ error: { code: "NOT_FOUND", message: "Asset not found", details: null } });
    }
    const adapter = services.storage.adapter;
    if (adapter.kind === "s3") {
      return reply.redirect(await adapter.downloadUrl(asset.storageKey), 302);
    }
    const buf = await adapter.read(asset.storageKey);
    if (!buf) {
      return reply.status(404).send({ error: { code: "NOT_FOUND", message: "File not found", details: null } });
    }
    return reply
      .header("content-type", asset.mime)
      .header("cache-control", "public, max-age=86400")
      .send(buf);
  });

  // List (JSON) — with ?populate=1, relations/media become inline summaries
  app.get("/delivery/:typeUid", async (req, reply) => {
    const { typeUid } = req.params as { typeUid: string };
    const query = req.query as Record<string, unknown>;
    const ctx = await buildCtx(query);
    // Body keeps its { items } shape (existing consumers); totals travel in headers
    const listed = await deliveryList(
      ctx,
      typeUid,
      typeof query.locale === "string" ? query.locale : undefined,
      {
        page: posInt(query.page, 1),
        pageSize: posInt(query.pageSize, 100),
      },
      // filters[field][$op]=value — a bad field/op throws ValidationError (422)
      parseFilterParams(query),
    );
    const items = listed.items;
    reply
      .header("x-total-count", String(listed.total))
      .header("x-page", String(listed.page))
      .header("x-page-size", String(listed.pageSize));
    if (query.populate === "1" && items.length > 0) {
      const type = await getDeliveryType(ctx, typeUid);
      const populated = await populateValuesList(ctx, type.definition, items.map((i) => i.values as Record<string, unknown>));
      items.forEach((item, i) => { item.values = populated[i]!; });
    }
    // SEO-enabled types also expose each item's resolved public URL (sitemap/head consumers)
    if (items.length > 0) {
      const type = await getDeliveryType(ctx, typeUid);
      const typeOptions = seoTypeOptions(type.options);
      if (typeOptions?.enabled) {
        const workspaceSeo = workspaceSeoSettings(ctx.workspace.settings);
        for (const item of items as Array<Record<string, unknown>>) {
          item.url = resolveEntryUrl({
            seo: (item.seo as import("@prina/shared").EntrySeo | null) ?? null,
            typeOptions,
            workspaceSeo,
            entry: {
              id: item.id as string,
              documentId: item.documentId as string,
              locale: item.locale as string,
            },
            values: item.values as Record<string, unknown>,
            displayValue: null,
          });
        }
      }
    }
    return reply.header("cache-control", cacheHeader(ctx)).send({ items });
  });

  /** Origin for absolute OG/asset URLs — honors the proxy headers fly/CDN setups send */
  function requestOrigin(req: { protocol: string; headers: Record<string, unknown> }): string {
    const fwdProto = req.headers["x-forwarded-proto"];
    const proto =
      typeof fwdProto === "string" ? fwdProto.split(",")[0]!.trim() : req.protocol;
    const fwdHost = req.headers["x-forwarded-host"];
    const host = typeof fwdHost === "string" ? fwdHost : (req.headers.host as string);
    return `${proto}://${host}`;
  }

  /** SEO payload for a resolved entry — null unless the type opted in (§0.11) */
  function buildEntrySeoPayload(
    ctx: DeliveryCtx,
    resolved: Awaited<ReturnType<typeof deliveryGet>>,
    origin: string,
  ): { url: string | null; title: string | null; head: string } | null {
    const typeOptions = seoTypeOptions(resolved.type.options);
    if (!typeOptions?.enabled) return null;
    const seoCtx: SeoContext = {
      seo: resolved.entry.seo ?? null,
      typeOptions,
      workspaceSeo: workspaceSeoSettings(ctx.workspace.settings),
      entry: {
        id: resolved.entry.id,
        documentId: resolved.entry.documentId,
        locale: resolved.entry.locale,
      },
      values: resolved.values,
      displayValue: displayValueOf(resolved.type.definition, resolved.values),
      schemaOrgType: resolved.type.schemaOrgType,
      requestOrigin: origin,
    };
    const tags = buildHeadTags(seoCtx);
    return { url: resolveEntryUrl(seoCtx), title: tags.title, head: serializeMetaLinks(tags) };
  }

  // Entry → JSON-LD (T9.1). Types without a schema.org mapping get 404
  async function buildEntryJsonLd(ctx: DeliveryCtx, resolved: Awaited<ReturnType<typeof deliveryGet>>) {
    if (!canBuildJsonLd(resolved.type.schemaOrgType)) return null;
    const [populated] = await populateValuesList(ctx, resolved.type.definition, [resolved.values]);
    const componentDefs = await loadComponentMap(ctx.db, ctx.workspace.id);
    const inverseEdges = await collectInverseEdges(ctx, resolved.entry.id);
    return buildJsonLd({
      inverseEdges,
      schemaOrgType: resolved.type.schemaOrgType,
      schemaOrgSecondary: resolved.type.schemaOrgSecondary,
      definition: resolved.type.definition,
      entryId: resolved.entry.id,
      populatedValues: populated!,
      registry: services.registry,
      componentDefs,
    });
  }

  // Single item — modes ①②③ (+ format=jsonld)
  app.get("/delivery/:typeUid/:id", async (req, reply) => {
    const { typeUid, id } = req.params as { typeUid: string; id: string };
    if (!UUID_RE.test(id)) return reply.status(400).send(badIdReply("Entry"));
    const query = req.query as Record<string, unknown>;
    const ctx = await buildCtx(query);
    const resolved = await deliveryGet(ctx, typeUid, id);

    if (query.format === "jsonld") {
      const ld = await buildEntryJsonLd(ctx, resolved);
      if (!ld) {
        return reply.status(404).send({
          error: { code: "NOT_FOUND", message: "Type has no schema.org mapping", details: null },
        });
      }
      return reply
        .header("content-type", "application/ld+json; charset=utf-8")
        .header("cache-control", cacheHeader(ctx))
        .send(ld);
    }

    const seoPayload = buildEntrySeoPayload(ctx, resolved, requestOrigin(req));

    // ?format=head — head snippet for SSR: consumers render this into <head>, format=html into <body>
    if (query.format === "head") {
      if (!seoPayload) {
        return reply.status(404).send({
          error: { code: "NOT_FOUND", message: "Type has no SEO configuration", details: null },
        });
      }
      const ld = await buildEntryJsonLd(ctx, resolved);
      const ldScript = ld
        ? `\n<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, "\\u003c")}</script>`
        : "";
      const title = seoPayload.title
        ? `<title>${seoPayload.title.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</title>\n`
        : "";
      return reply
        .header("content-type", "text/html; charset=utf-8")
        .header("cache-control", cacheHeader(ctx))
        .send(title + seoPayload.head + ldScript);
    }

    if (query.format !== "html") {
      const values =
        query.populate === "1"
          ? (await populateValuesList(ctx, resolved.type.definition, [resolved.values]))[0]!
          : resolved.values;
      return reply.header("cache-control", cacheHeader(ctx)).send({
        id: resolved.entry.id,
        documentId: resolved.entry.documentId,
        locale: resolved.entry.locale,
        status: resolved.entry.status,
        publishedAt: resolved.entry.publishedAt,
        type: resolved.type.uid,
        values,
        ...(seoPayload ? { seo: { ...seoPayload, record: resolved.entry.seo ?? null } } : {}),
      });
    }

    const rendered = await renderDelivery(
      ctx,
      resolved,
      typeof query.market === "string" ? query.market : undefined,
    );
    // Auto-attach the published entry's JSON-LD in HTML mode (§2.7 "auto-generated on publish")
    const ld = await buildEntryJsonLd(ctx, resolved);
    const ldScript = ld
      ? `<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, "\\u003c")}</script>`
      : "";

    if (query.embed === "1") {
      // Mode ③: embed.js assembles into a Shadow DOM (no scoping needed — the shadow isolates)
      return reply.header("cache-control", cacheHeader(ctx)).send({
        html: rendered.html,
        css: rendered.css,
        js: rendered.js,
        ga: rendered.ga,
        templateVersion: rendered.templateVersion,
        jsonld: ld,
        seo: seoPayload,
      });
    }
    // Mode ②: SSR fragment — head data rides along as a data script (prina-ga-config pattern)
    const seoScript = seoPayload
      ? `<script type="application/json" class="prina-seo">${JSON.stringify(seoPayload).replace(/</g, "\\u003c")}</script>`
      : "";
    return reply
      .header("content-type", "text/html; charset=utf-8")
      .header("cache-control", cacheHeader(ctx))
      .send(rendered.fragment + seoScript + ldScript);
  });
}

function parseVersion(tag: string): number {
  const m = /^v(\d+)$/.exec(tag);
  return m ? Number(m[1]) : NaN;
}

function cacheHeader(ctx: DeliveryCtx): string {
  // Responses including drafts must not be cached; published allows CDN caching
  return ctx.includeDraft ? "private, no-store" : "public, max-age=60, s-maxage=300";
}
