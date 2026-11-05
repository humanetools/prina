/**
 * Delivery service (T5.2) — lookup/render for the public serving path.
 * Read-only public plane outside the command pipeline (published only; draft via token).
 */
import { and, desc, eq, isNull, count, sql, type SQL } from "drizzle-orm";
import { ContentTypeKind, EntryStatus, FieldType, type ContentTypeDefinition } from "@prina/shared";
import {
  contentTypes,
  entries,
  locales,
  templatePartials,
  templates,
  workspaces,
} from "../../db/schema/index.js";
import type { Db } from "../../db/client.js";
import type { Services } from "../../commands/context.js";
import { NotFoundError } from "../../lib/errors.js";
import { buildFilterConditions, type FilterSpec } from "./filters.js";
import { renderLiquid } from "../../delivery/liquid.js";
import { populateValuesList } from "./populate.js";
import { scopeCss } from "../../delivery/css-scope.js";
import { buildGaPayloads, resolveMarket, ga4ConfigSchema } from "../../delivery/ga4.js";
import { fragmentRuntime } from "../../delivery/runtime.js";
import { resolveEffectiveValues, findVariantAxisField } from "../entry/variants.js";
import { loadCurrentPartials, partialSourceMap, usedPartialCss } from "../template/partial-commands.js";

export interface DeliveryCtx {
  db: Db;
  services: Services;
  workspace: { id: string; slug: string; settings: Record<string, unknown> };
  includeDraft: boolean;
}

export async function resolveWorkspace(db: Db, slug: string): Promise<DeliveryCtx["workspace"]> {
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.slug, slug)).limit(1);
  if (!ws) throw new NotFoundError(`Workspace '${slug}' not found`);
  return { id: ws.id, slug: ws.slug, settings: ws.settings };
}

export async function getDeliveryType(ctx: DeliveryCtx, typeUid: string) {
  return getType(ctx, typeUid);
}

async function getType(ctx: DeliveryCtx, typeUid: string) {
  const [type] = await ctx.db
    .select()
    .from(contentTypes)
    .where(and(eq(contentTypes.workspaceId, ctx.workspace.id), eq(contentTypes.uid, typeUid)))
    .limit(1);
  if (!type) throw new NotFoundError(`Type '${typeUid}' not found`);
  return type;
}

/** JSON mode ①: list (published only; everything with a draft token) */
export interface DeliveryListPage {
  /** 1-based */
  page: number;
  /** capped at 100 per request */
  pageSize: number;
}

/** Sort key (18-IMPL GraphQL orderBy) — meta columns or a top-level value field */
export interface DeliverySort {
  field: string;
  dir: "asc" | "desc";
  /** number fields sort numerically (jsonb_typeof guard — non-numbers sort last) */
  numeric?: boolean;
}

export async function deliveryList(
  ctx: DeliveryCtx,
  typeUid: string,
  locale?: string,
  paging?: DeliveryListPage,
  filters?: FilterSpec[],
  sort?: DeliverySort[],
  /** Conditions built elsewhere over `entries` (taxonomy membership — 22-IMPL) */
  extraConds?: SQL[],
) {
  const type = await getType(ctx, typeUid);
  const conds: SQL[] = [
    eq(entries.contentTypeId, type.id),
    isNull(entries.parentEntryId),
  ];
  if (!ctx.includeDraft) conds.push(eq(entries.status, EntryStatus.Published));
  if (locale) conds.push(eq(entries.locale, locale));
  if (filters?.length) {
    conds.push(...buildFilterConditions(type.definition as ContentTypeDefinition, filters));
  }
  if (extraConds?.length) conds.push(...extraConds);
  const where = and(...conds);
  const page = Math.max(1, paging?.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, paging?.pageSize ?? 100));
  const [totalRow] = await ctx.db
    .select({ value: count() })
    .from(entries)
    .where(where);
  const fieldNames = new Set((type.definition as ContentTypeDefinition).fields.map((f) => f.name));
  const orderExprs: SQL[] = (sort ?? [])
    .filter((s) => s.field === "publishedAt" || s.field === "updatedAt" || fieldNames.has(s.field))
    .map((s) => {
      const dir = s.dir === "asc" ? sql`ASC` : sql`DESC`;
      if (s.field === "publishedAt") return sql`${entries.publishedAt} ${dir} NULLS LAST`;
      if (s.field === "updatedAt") return sql`${entries.updatedAt} ${dir}`;
      const node = sql`${entries.values} -> ${s.field}`;
      return s.numeric
        ? sql`(CASE WHEN jsonb_typeof(${node}) = 'number' THEN (${node})::numeric END) ${dir} NULLS LAST`
        : sql`(${entries.values} ->> ${s.field}) ${dir} NULLS LAST`;
    });
  const rows = await ctx.db
    .select()
    .from(entries)
    .where(where)
    // id tiebreaker keeps pages stable when publishedAt ties (bulk publishes share a timestamp)
    .orderBy(...orderExprs, desc(entries.publishedAt), desc(entries.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  const items = rows.map((e) => ({
    id: e.id,
    documentId: e.documentId,
    locale: e.locale,
    status: e.status,
    publishedAt: e.publishedAt,
    updatedAt: e.updatedAt,
    values: e.values,
    /** SEO record — public metadata; canonical overrides feed list url resolution */
    seo: e.seo ?? null,
  }));
  return { items, total: totalRow?.value ?? 0, page, pageSize };
}

export interface ResolvedEntry {
  type: typeof contentTypes.$inferSelect;
  entry: typeof entries.$inferSelect;
  values: Record<string, unknown>;
}

export async function deliveryGet(
  ctx: DeliveryCtx,
  typeUid: string,
  entryId: string,
): Promise<ResolvedEntry> {
  const type = await getType(ctx, typeUid);
  const [entry] = await ctx.db
    .select()
    .from(entries)
    .where(and(eq(entries.contentTypeId, type.id), eq(entries.id, entryId)))
    .limit(1);
  if (!entry) throw new NotFoundError("Entry not found");
  if (!ctx.includeDraft && entry.status !== EntryStatus.Published) {
    // Avoid revealing existence — respond 404
    throw new NotFoundError("Entry not found");
  }
  let parent = null;
  if (entry.parentEntryId) {
    const [p] = await ctx.db
      .select()
      .from(entries)
      .where(eq(entries.id, entry.parentEntryId))
      .limit(1);
    parent = p ?? null;
  }
  const values = resolveEffectiveValues(type.definition, entry, parent);
  const axis = findVariantAxisField(type.definition);
  if (axis) delete values[axis.name];
  return { type, entry, values };
}

export interface RenderedFragment {
  /** Mode ②: finished fragment for SSR (links + runtime included) */
  fragment: string;
  /** Mode ③: raw materials for embed */
  html: string;
  css: string;
  js: string;
  ga: ReturnType<typeof buildGaPayloads>;
  templateVersion: number;
  /** Partials the render used that carry script.js (39-IMPL) — served version-pinned like template assets */
  partials: Array<{ name: string; version: number }>;
}

/** `{% render %}` present — only then is the partial table read for a render */
const USES_PARTIALS = /\{%-?\s*render\b/;

export interface RenderOptions {
  /**
   * `?populate=1` on the render path — relations/media in the Liquid scope become inline objects
   * (relation targets carry `values`, depth 1) so a section template can draw a referenced list
   * without a consumer-side compose step. GA payloads still read the raw values.
   */
  populate?: boolean;
}

/** Shared render for modes ②③ */
export async function renderDelivery(
  ctx: DeliveryCtx,
  resolved: ResolvedEntry,
  /** ?market= — selects the currency/GTM container when the site serves markets separately */
  market?: string,
  options: RenderOptions = {},
): Promise<RenderedFragment> {
  const [template] = await ctx.db
    .select()
    .from(templates)
    .where(and(eq(templates.contentTypeId, resolved.type.id), eq(templates.isCurrent, true)))
    .limit(1);
  if (!template) {
    throw new NotFoundError(`Type '${resolved.type.uid}' has no published template`);
  }

  const scopeValues = options.populate
    ? (await populateValuesList(ctx, resolved.type.definition, [resolved.values], { withValues: true }))[0]!
    : resolved.values;
  // Partials (39-IMPL): the page template dispatches blocks to `{% render blk.__component %}`.
  // Only the partials a render actually touched contribute their script.js.
  const partialRows = USES_PARTIALS.test(template.liquid)
    ? await loadCurrentPartials(ctx.db, ctx.workspace.id)
    : [];
  const usedNames = new Set<string>();
  const html = await renderLiquid({
    liquid: template.liquid,
    scope: {
      entry: {
        id: resolved.entry.id,
        locale: resolved.entry.locale,
        status: resolved.entry.status,
      },
      values: scopeValues,
      type: { uid: resolved.type.uid, name: resolved.type.name },
    },
    storage: ctx.services.storage,
    partials: partialSourceMap(partialRows),
    onPartialUsed: (name) => usedNames.add(name),
  });
  // Used partials carry their own style.css / script.js (40-IMPL component markup): both are
  // version-pinned URLs in the fragment, and inlined after the template's own in embed mode.
  const usedPartials = partialRows
    .filter((p) => usedNames.has(p.name) && (p.js.trim() !== "" || p.css.trim() !== ""))
    .sort((a, b) => a.name.localeCompare(b.name));
  const partialBase = (name: string, version: number) => `/delivery/templates/partials/${name}/v${version}`;

  const gaConfig = ga4ConfigSchema.parse(template.events ?? {});
  // Per-market currency/GTM container (§ GA4 markets) — ?market= wins, else the entry locale
  const mk = resolveMarket(ctx.workspace.settings, market, resolved.entry.locale);
  const ga = {
    ...buildGaPayloads(gaConfig, resolved.values, mk.currency),
    market: mk.market,
    ...(mk.containerId ? { containerId: mk.containerId } : {}),
  };

  const scopeClass = `hub-${resolved.type.uid}`;
  const rootId = `prina-${resolved.entry.id}`;
  const base = `/delivery/templates/${resolved.type.uid}/v${template.version}`;
  const fragment = [
    `<div id="${rootId}" class="${scopeClass}" data-prina-entry="${resolved.entry.id}">`,
    `<link rel="stylesheet" href="${base}/style.css">`,
    ...usedPartials
      .filter((p) => p.css.trim() !== "")
      .map((p) => `<link rel="stylesheet" href="${partialBase(p.name, p.version)}/style.css">`),
    html,
    `<script type="application/json" class="prina-ga-config">${JSON.stringify(ga)}</script>`,
    `<script>${fragmentRuntime(rootId)}</script>`,
    template.js.trim() ? `<script defer src="${base}/script.js"></script>` : "",
    ...usedPartials
      .filter((p) => p.js.trim() !== "")
      .map((p) => `<script defer src="${partialBase(p.name, p.version)}/script.js"></script>`),
    `</div>`,
  ].join("\n");

  return {
    fragment,
    html,
    // Mode ③ gets one stylesheet — template css first, then each used partial's css
    css: [template.css, usedPartialCss(partialRows, usedNames)].filter((s) => s.trim() !== "").join("\n"),
    // Mode ③ runs one script blob — template js first, then each used partial's js
    js: [template.js, ...usedPartials.map((p) => p.js)].filter((s) => s.trim() !== "").join("\n;\n"),
    ga,
    templateVersion: template.version,
    partials: usedPartials.map((p) => ({
      name: p.name,
      version: p.version,
      hasCss: p.css.trim() !== "",
      hasJs: p.js.trim() !== "",
    })),
  };
}

/**
 * Version-pinned partial assets — /delivery/templates/partials/{name}/v{n}/script.js (39-IMPL)
 * and style.css (40-IMPL). A block always sits inside a page root, so the css is scoped to the
 * page type's class when `scopeTo` is given (fragment `<link>`s pass none: the page's own
 * stylesheet already scopes, and a partial is reused across page types).
 */
export async function getPartialAsset(
  ctx: DeliveryCtx,
  name: string,
  version: number,
  kind: "js" | "css" = "js",
): Promise<string> {
  if (!Number.isSafeInteger(version) || version < 1) throw new NotFoundError("Partial version not found");
  const [row] = await ctx.db
    .select({ js: templatePartials.js, css: templatePartials.css })
    .from(templatePartials)
    .where(
      and(
        eq(templatePartials.workspaceId, ctx.workspace.id),
        eq(templatePartials.name, name),
        eq(templatePartials.version, version),
      ),
    )
    .limit(1);
  if (!row) throw new NotFoundError("Partial version not found");
  return kind === "css" ? row.css : row.js;
}

/**
 * Field files (39-IMPL C4) — a text field of a single type served as a file:
 * GET /delivery/site_assets/common_css.css. Lets a page `<link>` design-system CSS that editors
 * maintain as content, with browser/CDN caching keyed on the entry's last change.
 */
export const FIELD_FILE_TYPES: Readonly<Record<string, string>> = {
  css: "text/css; charset=utf-8",
  js: "application/javascript; charset=utf-8",
  svg: "image/svg+xml; charset=utf-8",
  json: "application/json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  html: "text/html; charset=utf-8",
};

export const FIELD_FILE_RE = /^([a-z][a-z0-9_]*)\.(css|js|svg|json|txt|html)$/;

export interface FieldFile {
  body: string;
  contentType: string;
  /** Weak validator — changes whenever the serving entry is saved again */
  etag: string;
}

export async function getFieldFile(
  ctx: DeliveryCtx,
  typeUid: string,
  field: string,
  ext: string,
  locale?: string,
): Promise<FieldFile> {
  const contentType = FIELD_FILE_TYPES[ext];
  if (!contentType) throw new NotFoundError("Unsupported file extension");
  const type = await getType(ctx, typeUid);
  if (type.kind !== ContentTypeKind.Single) {
    throw new NotFoundError("Field files are served from single types only");
  }
  const def = type.definition.fields.find((f) => f.name === field);
  const textLike = def?.type === FieldType.Text || (ext === "json" && def?.type === FieldType.Json);
  if (!def || !textLike) throw new NotFoundError(`Field '${field}' is not a text field`);

  const conds: SQL[] = [eq(entries.contentTypeId, type.id)];
  if (!ctx.includeDraft) conds.push(eq(entries.status, EntryStatus.Published));
  if (locale) conds.push(eq(entries.locale, locale));
  const rows = await ctx.db
    .select()
    .from(entries)
    .where(and(...conds))
    .orderBy(desc(entries.updatedAt))
    .limit(50);
  if (rows.length === 0) throw new NotFoundError("Entry not found");
  let entry = rows[0]!;
  if (!locale && rows.length > 1) {
    // Several locales — prefer the workspace default
    const [dl] = await ctx.db
      .select({ code: locales.code })
      .from(locales)
      .where(and(eq(locales.workspaceId, ctx.workspace.id), eq(locales.isDefault, true)))
      .limit(1);
    const hit = dl ? rows.find((r) => r.locale === dl.code) : undefined;
    if (hit) entry = hit;
  }
  const raw = (entry.values as Record<string, unknown>)[field];
  const body = ext === "json" && def.type === FieldType.Json
    ? JSON.stringify(raw ?? null)
    : typeof raw === "string" ? raw : "";
  return {
    body,
    contentType,
    etag: `W/"${entry.id.slice(0, 8)}-${entry.updatedAt.getTime()}"`,
  };
}

/** Version-pinned CSS/JS (T5.2: /templates/{type}/v{n}/style.css — CDN-cacheable) */
export async function getTemplateAsset(
  ctx: DeliveryCtx,
  typeUid: string,
  version: number,
  kind: "css" | "js",
): Promise<string> {
  // versionTag comes off the public URL unvalidated — NaN/overflow must be a 404, not a PG error
  if (!Number.isSafeInteger(version) || version < 1) throw new NotFoundError("Template version not found");
  const type = await getType(ctx, typeUid);
  const [template] = await ctx.db
    .select()
    .from(templates)
    .where(and(eq(templates.contentTypeId, type.id), eq(templates.version, version)))
    .limit(1);
  if (!template) throw new NotFoundError("Template version not found");
  if (kind === "css") return scopeCss(template.css, `.hub-${typeUid}`);
  return template.js;
}
