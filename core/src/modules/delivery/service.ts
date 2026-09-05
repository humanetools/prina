/**
 * Delivery service (T5.2) — lookup/render for the public serving path.
 * Read-only public plane outside the command pipeline (published only; draft via token).
 */
import { and, desc, eq, isNull, count, type SQL } from "drizzle-orm";
import { EntryStatus, type ContentTypeDefinition } from "@prina/shared";
import {
  contentTypes,
  entries,
  templates,
  workspaces,
} from "../../db/schema/index.js";
import type { Db } from "../../db/client.js";
import type { Services } from "../../commands/context.js";
import { NotFoundError } from "../../lib/errors.js";
import { buildFilterConditions, type FilterSpec } from "./filters.js";
import { renderLiquid } from "../../delivery/liquid.js";
import { scopeCss } from "../../delivery/css-scope.js";
import { buildGaPayloads, resolveMarket, ga4ConfigSchema } from "../../delivery/ga4.js";
import { fragmentRuntime } from "../../delivery/runtime.js";
import { resolveEffectiveValues, findVariantAxisField } from "../entry/variants.js";

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

export async function deliveryList(
  ctx: DeliveryCtx,
  typeUid: string,
  locale?: string,
  paging?: DeliveryListPage,
  filters?: FilterSpec[],
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
  const where = and(...conds);
  const page = Math.max(1, paging?.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, paging?.pageSize ?? 100));
  const [totalRow] = await ctx.db
    .select({ value: count() })
    .from(entries)
    .where(where);
  const rows = await ctx.db
    .select()
    .from(entries)
    .where(where)
    // id tiebreaker keeps pages stable when publishedAt ties (bulk publishes share a timestamp)
    .orderBy(desc(entries.publishedAt), desc(entries.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  const items = rows.map((e) => ({
    id: e.id,
    documentId: e.documentId,
    locale: e.locale,
    status: e.status,
    publishedAt: e.publishedAt,
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
}

/** Shared render for modes ②③ */
export async function renderDelivery(
  ctx: DeliveryCtx,
  resolved: ResolvedEntry,
  /** ?market= — selects the currency/GTM container when the site serves markets separately */
  market?: string,
): Promise<RenderedFragment> {
  const [template] = await ctx.db
    .select()
    .from(templates)
    .where(and(eq(templates.contentTypeId, resolved.type.id), eq(templates.isCurrent, true)))
    .limit(1);
  if (!template) {
    throw new NotFoundError(`Type '${resolved.type.uid}' has no published template`);
  }

  const html = await renderLiquid({
    liquid: template.liquid,
    scope: {
      entry: {
        id: resolved.entry.id,
        locale: resolved.entry.locale,
        status: resolved.entry.status,
      },
      values: resolved.values,
      type: { uid: resolved.type.uid, name: resolved.type.name },
    },
    storage: ctx.services.storage,
  });

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
    html,
    `<script type="application/json" class="prina-ga-config">${JSON.stringify(ga)}</script>`,
    `<script>${fragmentRuntime(rootId)}</script>`,
    template.js.trim() ? `<script defer src="${base}/script.js"></script>` : "",
    `</div>`,
  ].join("\n");

  return {
    fragment,
    html,
    css: template.css,
    js: template.js,
    ga,
    templateVersion: template.version,
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
