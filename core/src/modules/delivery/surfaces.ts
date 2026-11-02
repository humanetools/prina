/**
 * GEO/SEO public surfaces (§0.11 Phase 2) — shared data source for sitemap.xml and llms.txt.
 * Published, non-variant entries of SEO-enabled types, with resolved public URLs.
 * These surfaces never honor draft tokens.
 */
import { and, desc, eq, isNull } from "drizzle-orm";
import type { EntrySeo, SeoTypeOptions } from "@prina/shared";
import { EntryStatus } from "@prina/shared";
import { contentTypes, entries } from "../../db/schema/index.js";
import {
  displayValueOf,
  resolveEntryUrl,
  resolveOwnUrl,
  seoTypeOptions,
  workspaceSeoSettings,
} from "../../delivery/seo.js";
import type { DeliveryCtx } from "./service.js";

/** Runaway backstop — sitemap-index pagination is a follow-up once real workspaces near this */
export const SITEMAP_URL_CAP = 5000;
/** llms.txt entries per type — agents want a survey, not a dump */
export const LLMS_PER_TYPE_CAP = 200;

export interface SurfaceEntry {
  id: string;
  documentId: string;
  locale: string;
  updatedAt: Date;
  /** Canonical URL (may point at an external original for syndicated collections) */
  url: string | null;
  /** This site's own URL (siteBaseUrl + pattern) — what the sitemap may list */
  ownUrl: string | null;
  noindex: boolean;
  displayValue: string | null;
  metaDescription: string | null;
}

export interface SurfaceType {
  uid: string;
  name: string;
  description: string | null;
  schemaOrgType: string | null;
  seo: SeoTypeOptions;
  entries: SurfaceEntry[];
}

/** All SEO-enabled types with their published entries, newest first, URLs resolved */
export async function listPublishedForSurfaces(ctx: DeliveryCtx): Promise<SurfaceType[]> {
  const workspaceSeo = workspaceSeoSettings(ctx.workspace.settings);
  const rows = await ctx.db
    .select({
      entryId: entries.id,
      documentId: entries.documentId,
      locale: entries.locale,
      values: entries.values,
      seo: entries.seo,
      updatedAt: entries.updatedAt,
      typeId: contentTypes.id,
      typeUid: contentTypes.uid,
      typeName: contentTypes.name,
      typeDescription: contentTypes.description,
      schemaOrgType: contentTypes.schemaOrgType,
      definition: contentTypes.definition,
      options: contentTypes.options,
    })
    .from(entries)
    .innerJoin(contentTypes, eq(entries.contentTypeId, contentTypes.id))
    .where(
      and(
        eq(entries.workspaceId, ctx.workspace.id),
        eq(entries.status, EntryStatus.Published),
        isNull(entries.parentEntryId),
      ),
    )
    .orderBy(desc(entries.updatedAt));

  const byType = new Map<string, SurfaceType>();
  for (const row of rows) {
    const typeSeo = seoTypeOptions(row.options);
    if (!typeSeo?.enabled) continue;
    let bucket = byType.get(row.typeUid);
    if (!bucket) {
      bucket = {
        uid: row.typeUid,
        name: row.typeName,
        description: row.typeDescription,
        schemaOrgType: row.schemaOrgType,
        seo: typeSeo,
        entries: [],
      };
      byType.set(row.typeUid, bucket);
    }
    const seo = (row.seo ?? null) as EntrySeo | null;
    const values = row.values as Record<string, unknown>;
    const entry = { id: row.entryId, documentId: row.documentId, locale: row.locale };
    const seoCtx = {
      seo,
      typeOptions: typeSeo,
      workspaceSeo,
      entry,
      values,
      displayValue: null,
    };
    bucket.entries.push({
      ...entry,
      updatedAt: row.updatedAt,
      url: resolveEntryUrl(seoCtx),
      ownUrl: resolveOwnUrl(seoCtx),
      noindex: seo?.noindex === true,
      displayValue: displayValueOf(row.definition, values),
      metaDescription: seo?.metaDescription ?? null,
    });
  }
  return [...byType.values()];
}

function xmlEscape(v: string): string {
  return v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** sitemap.xml — indexable entries of types with sitemap.include; locale alternates by document */
export function buildSitemapXml(types: SurfaceType[]): string {
  // Alternate lookup: document → locale entries with a URL (self included, sitemap spec style).
  // Locales may share one URL when the pattern has no {locale} and slugs match across locales
  // (uid uniqueness is per-locale) — alternates only make sense when the URLs actually differ.
  // A sitemap must list canonical URLs only: entries whose canonical points elsewhere
  // (external pattern or API-set canonical) are skipped like noindex.
  const included = types.filter((t) => t.seo.sitemap?.include === true);
  const listable = (e: SurfaceEntry) => !!e.ownUrl && !e.noindex && e.url === e.ownUrl;
  const byDocument = new Map<string, SurfaceEntry[]>();
  for (const t of included) {
    for (const e of t.entries) {
      if (!listable(e)) continue;
      const list = byDocument.get(e.documentId) ?? [];
      if (!list.some((s) => s.url === e.url)) list.push(e);
      byDocument.set(e.documentId, list);
    }
  }

  const urls: string[] = [];
  const seen = new Set<string>();
  let truncated = false;
  outer: for (const t of included) {
    for (const e of t.entries) {
      if (!listable(e) || seen.has(e.url!)) continue;
      seen.add(e.url!);
      if (urls.length >= SITEMAP_URL_CAP) {
        truncated = true;
        break outer;
      }
      const parts = [
        `  <url>`,
        `    <loc>${xmlEscape(e.url!)}</loc>`,
        `    <lastmod>${e.updatedAt.toISOString().slice(0, 10)}</lastmod>`,
      ];
      if (t.seo.sitemap?.changefreq) {
        parts.push(`    <changefreq>${t.seo.sitemap.changefreq}</changefreq>`);
      }
      if (t.seo.sitemap?.priority !== undefined) {
        parts.push(`    <priority>${t.seo.sitemap.priority}</priority>`);
      }
      const siblings = byDocument.get(e.documentId) ?? [];
      if (siblings.length > 1) {
        for (const alt of siblings) {
          parts.push(
            `    <xhtml:link rel="alternate" hreflang="${xmlEscape(alt.locale)}" href="${xmlEscape(alt.url!)}"/>`,
          );
        }
      }
      parts.push(`  </url>`);
      urls.push(parts.join("\n"));
    }
  }

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">`,
    ...urls,
    truncated ? `  <!-- truncated at ${SITEMAP_URL_CAP} URLs -->` : "",
    `</urlset>`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** robots.txt — mainly for Prina-hosted setups (or customers proxying /robots.txt here) */
export function buildRobotsTxt(
  ctx: DeliveryCtx,
  origin: string,
  extraDisallow: string[],
): string {
  const lines = ["User-agent: *"];
  for (const path of extraDisallow) lines.push(`Disallow: ${path}`);
  if (extraDisallow.length === 0) lines.push("Disallow:");
  lines.push("", `Sitemap: ${origin}/delivery/sitemap.xml?ws=${ctx.workspace.slug}`);
  return lines.join("\n") + "\n";
}

/** llms.txt — a survey of the workspace's published content for AI agents (GEO surface) */
export function buildLlmsTxt(
  ctx: DeliveryCtx,
  origin: string,
  workspaceName: string,
  types: SurfaceType[],
): string {
  const lines = [`# ${workspaceName}`, ""];
  lines.push(
    `> Structured content from this hub. JSON per entry at ${origin}/delivery/{type}/{id}?ws=${ctx.workspace.slug}; schema.org JSON-LD via ?format=jsonld.`,
    "",
  );
  for (const t of types) {
    const label = t.schemaOrgType ? `${t.name} (schema.org ${t.schemaOrgType})` : t.name;
    lines.push(`## ${label}`, "");
    if (t.description) lines.push(`> ${t.description}`, "");
    let count = 0;
    const seen = new Set<string>();
    for (const e of t.entries) {
      if (e.noindex) continue;
      const href =
        e.url ??
        `${origin}/delivery/${encodeURIComponent(t.uid)}/${e.id}?ws=${ctx.workspace.slug}`;
      // Locale variants sharing one URL collapse to a single line
      if (seen.has(href)) continue;
      seen.add(href);
      if (count >= LLMS_PER_TYPE_CAP) {
        lines.push(`- … (more entries not listed)`);
        break;
      }
      const title = e.displayValue ?? e.id;
      lines.push(`- [${title}](${href})${e.metaDescription ? `: ${e.metaDescription}` : ""}`);
      count++;
    }
    lines.push("");
  }
  return lines.join("\n");
}
