/**
 * SEO head derivation (§0.11 SEO axis) — sits beside jsonld.ts/ga4.ts.
 * Single source for canonical URL resolution and <head> tag construction, consumed by
 * delivery (JSON/head/fragment/embed), sitemap/llms.txt surfaces, and the admin preview.
 */
import type { EntrySeo, SeoTypeOptions, WorkspaceSeoSettings } from "@prina/shared";

export interface SeoEntryRef {
  id: string;
  documentId: string;
  locale: string;
}

export interface SeoContext {
  seo: EntrySeo | null;
  typeOptions: SeoTypeOptions | null;
  workspaceSeo: WorkspaceSeoSettings | null;
  entry: SeoEntryRef;
  values: Record<string, unknown>;
  /** Display-field value used as the metaTitle fallback (null convention, like populate/jsonld) */
  displayValue: string | null;
  /** schema.org primary type — drives og:type */
  schemaOrgType?: string | null;
  /** Origin used to absolutize /delivery/assets URLs for OG scrapers */
  requestOrigin?: string | null;
}

/** Untrusted-JSONB readers — options/settings columns are typed loosely at the DB layer */
export function seoTypeOptions(options: unknown): SeoTypeOptions | null {
  if (!options || typeof options !== "object") return null;
  const seo = (options as { seo?: unknown }).seo;
  if (!seo || typeof seo !== "object") return null;
  return seo as SeoTypeOptions;
}

export function workspaceSeoSettings(settings: unknown): WorkspaceSeoSettings | null {
  if (!settings || typeof settings !== "object") return null;
  const seo = (settings as { seo?: unknown }).seo;
  if (!seo || typeof seo !== "object") return null;
  return seo as WorkspaceSeoSettings;
}

/** displayField value as a plain string — null when absent/non-scalar (populate/jsonld convention) */
export function displayValueOf(
  definition: { displayField?: string },
  values: Record<string, unknown>,
): string | null {
  if (!definition.displayField) return null;
  const raw = values[definition.displayField];
  if (typeof raw === "string" && raw !== "") return raw;
  if (typeof raw === "number") return String(raw);
  return null;
}

const TOKEN_PATTERN = /\{([a-zA-Z0-9_-]+)\}/g;

/**
 * Interpolates a "/products/{slug}" style pattern from entry values.
 * Any unresolvable or empty token voids the whole URL — never emit a broken canonical.
 */
export function interpolateUrlPattern(
  pattern: string,
  entry: SeoEntryRef,
  values: Record<string, unknown>,
): string | null {
  let failed = false;
  const path = pattern.replace(TOKEN_PATTERN, (_m, token: string) => {
    let raw: unknown;
    if (token === "id") raw = entry.id;
    else if (token === "documentId") raw = entry.documentId;
    else if (token === "locale") raw = entry.locale;
    else raw = values[token];
    if (raw === null || raw === undefined || raw === "") {
      failed = true;
      return "";
    }
    if (typeof raw !== "string" && typeof raw !== "number") {
      failed = true;
      return "";
    }
    return encodeURIComponent(String(raw));
  });
  return failed ? null : path;
}

/** The entry's own URL on this site: siteBaseUrl + urlPattern (no canonical overrides) */
export function resolveOwnUrl(ctx: SeoContext): string | null {
  const base = ctx.workspaceSeo?.siteBaseUrl;
  const pattern = ctx.typeOptions?.urlPattern;
  if (!base || !pattern) return null;
  const path = interpolateUrlPattern(pattern, ctx.entry, ctx.values);
  if (path === null) return null;
  return base.replace(/\/+$/, "") + (path.startsWith("/") ? path : `/${path}`);
}

/**
 * Canonical resolution: entry-level canonical (API-only field) → the type's external
 * canonical pattern (syndicated collections) → the entry's own URL → null.
 * An unresolvable external pattern falls through to the own URL — never emit a broken link.
 */
export function resolveEntryUrl(ctx: SeoContext): string | null {
  if (ctx.seo?.canonical) return ctx.seo.canonical;
  const external = ctx.typeOptions?.externalCanonicalPattern;
  if (external) {
    const url = interpolateUrlPattern(external, ctx.entry, ctx.values);
    if (url !== null) return url;
  }
  return resolveOwnUrl(ctx);
}

export interface HeadTags {
  title: string | null;
  meta: Array<{ name?: string; property?: string; content: string }>;
  link: Array<{ rel: string; href: string }>;
}

/** schema.org type → og:type (coarse mapping; default "website") */
function ogType(schemaOrgType: string | null | undefined): string {
  if (!schemaOrgType) return "website";
  if (/Article|BlogPosting|NewsArticle/i.test(schemaOrgType)) return "article";
  if (/^Product$/i.test(schemaOrgType)) return "product";
  if (/^Person$/i.test(schemaOrgType)) return "profile";
  return "website";
}

export function buildHeadTags(ctx: SeoContext): HeadTags {
  const seo = ctx.seo ?? {};
  const ws = ctx.workspaceSeo ?? {};
  const meta: HeadTags["meta"] = [];
  const link: HeadTags["link"] = [];

  const baseTitle = seo.metaTitle || ctx.displayValue || null;
  const title = baseTitle ? baseTitle + (ws.titleSuffix ?? "") : null;
  const description = seo.metaDescription || null;
  const url = resolveEntryUrl(ctx);

  if (description) meta.push({ name: "description", content: description });
  if (seo.noindex) meta.push({ name: "robots", content: "noindex" });
  if (url) link.push({ rel: "canonical", href: url });

  const ogTitle = seo.ogTitle || baseTitle;
  const ogDescription = seo.ogDescription || description;
  const ogImageId = seo.ogImage || ws.defaultOgImage || null;
  const origin = ctx.requestOrigin?.replace(/\/+$/, "") ?? "";
  const ogImageUrl = ogImageId ? `${origin}/delivery/assets/${ogImageId}` : null;

  if (ogTitle) meta.push({ property: "og:title", content: ogTitle });
  if (ogDescription) meta.push({ property: "og:description", content: ogDescription });
  if (url) meta.push({ property: "og:url", content: url });
  meta.push({ property: "og:type", content: ogType(ctx.schemaOrgType) });
  meta.push({ property: "og:locale", content: ctx.entry.locale });
  if (ogImageUrl) {
    meta.push({ property: "og:image", content: ogImageUrl });
    meta.push({ name: "twitter:card", content: "summary_large_image" });
  }

  return { title, meta, link };
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** meta+link serialization without <title> — embed.js appends this to the host head (title is set via document.title) */
export function serializeMetaLinks(tags: HeadTags): string {
  const parts: string[] = [];
  for (const m of tags.meta) {
    const key = m.name ? `name="${escapeAttr(m.name)}"` : `property="${escapeAttr(m.property!)}"`;
    parts.push(`<meta ${key} content="${escapeAttr(m.content)}">`);
  }
  for (const l of tags.link) {
    parts.push(`<link rel="${escapeAttr(l.rel)}" href="${escapeAttr(l.href)}">`);
  }
  return parts.join("\n");
}

/** HTML serialization of head tags — the ?format=head payload (JSON-LD script appended by the route) */
export function serializeHeadTags(tags: HeadTags): string {
  const title = tags.title ? `<title>${escapeAttr(tags.title)}</title>\n` : "";
  return title + serializeMetaLinks(tags);
}
