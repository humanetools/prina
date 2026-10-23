/**
 * Publish-readiness advisories (§0.11) — SEO/a11y checks beside the completeness score.
 * Default mode only surfaces them (entry detail, admin right panel); a type with
 * options.seo.strictPublish blocks the publish transition on error-severity items.
 */
import { and, eq, inArray } from "drizzle-orm";
import { FieldType } from "@prina/shared";
import type {
  ContentTypeDefinition,
  EntrySeo,
  MediaFieldDef,
  PublishAdvisory,
  SeoTypeOptions,
  WorkspaceSeoSettings,
} from "@prina/shared";
import { assets } from "../../db/schema/index.js";
import { toMediaRefs } from "../../content/field-types/media.js";
import { resolveEntryUrl, type SeoEntryRef } from "../../delivery/seo.js";
import type { Db } from "../../db/client.js";

/** Search-snippet guidance bounds (Google truncation heuristics) */
const TITLE_MAX = 60;
const DESCRIPTION_MIN = 50;
const DESCRIPTION_MAX = 160;

export interface AdvisoryInput {
  typeOptions: SeoTypeOptions | null;
  workspaceSeo: WorkspaceSeoSettings | null;
  entry: SeoEntryRef;
  values: Record<string, unknown>;
  seo: EntrySeo | null;
  /** metaTitle fallback (displayField value), null when absent */
  displayValue: string | null;
}

export function computePublishAdvisories(input: AdvisoryInput): PublishAdvisory[] {
  const opts = input.typeOptions;
  if (!opts?.enabled) return [];
  const advisories: PublishAdvisory[] = [];
  const seo = input.seo ?? {};

  const effectiveTitle = seo.metaTitle || input.displayValue || null;
  if (!effectiveTitle) {
    advisories.push({
      code: "seo-meta-title-missing",
      severity: "error",
      field: "metaTitle",
      message: "Meta title is empty and the type has no display field value to fall back to",
    });
  } else if (effectiveTitle.length > TITLE_MAX) {
    advisories.push({
      code: "seo-meta-title-long",
      severity: "warn",
      field: "metaTitle",
      message: `Meta title is ${effectiveTitle.length} chars — search engines truncate around ${TITLE_MAX}`,
    });
  }

  if (!seo.metaDescription) {
    advisories.push({
      code: "seo-meta-description-missing",
      severity: "error",
      field: "metaDescription",
      message: "Meta description is empty",
    });
  } else if (
    seo.metaDescription.length < DESCRIPTION_MIN ||
    seo.metaDescription.length > DESCRIPTION_MAX
  ) {
    advisories.push({
      code: "seo-meta-description-length",
      severity: "warn",
      field: "metaDescription",
      message: `Meta description is ${seo.metaDescription.length} chars — aim for ${DESCRIPTION_MIN}–${DESCRIPTION_MAX}`,
    });
  }

  const url = resolveEntryUrl({
    seo: input.seo,
    typeOptions: opts,
    workspaceSeo: input.workspaceSeo,
    entry: input.entry,
    values: input.values,
    displayValue: input.displayValue,
  });
  const inSitemap = opts.sitemap?.include === true;
  if (!url) {
    advisories.push({
      code: "seo-url-unresolvable",
      // An unresolvable URL silently drops the entry from the sitemap — error there
      severity: inSitemap ? "error" : "warn",
      message:
        "Canonical URL cannot be resolved — set the site base URL and this type's URL pattern",
    });
  }
  if (seo.noindex && inSitemap) {
    advisories.push({
      code: "seo-noindex-in-sitemap",
      severity: "warn",
      field: "noindex",
      message: "Entry is noindex but its type is included in the sitemap (it will be skipped)",
    });
  }

  return advisories;
}

/**
 * Alt-text advisories (§0.12, WA axis) — independent of the SEO toggle. For every media field
 * with altText enabled: effective alt = usage override ?? asset alt; "" (decorative) counts as
 * described. Runs where DB access exists (entryGet/transition/preview), not in completeness,
 * to keep the isFilled(def, value) signature value-only.
 */
export async function computeAltAdvisories(
  db: Db,
  workspaceId: string,
  definition: ContentTypeDefinition,
  values: Record<string, unknown>,
): Promise<PublishAdvisory[]> {
  const pending: Array<{ field: string; label?: string; id: string }> = [];
  for (const field of definition.fields) {
    if (field.type !== FieldType.Media) continue;
    const def = field as MediaFieldDef;
    if (def.altText !== true) continue;
    for (const ref of toMediaRefs(def, values[def.name])) {
      // A string override (incl. "") settles it without a lookup
      if (typeof ref.alt === "string") continue;
      pending.push({ field: def.name, label: def.label, id: ref.id });
    }
  }
  if (pending.length === 0) return [];

  const rows = await db
    .select({ id: assets.id, alt: assets.alt, filename: assets.filename })
    .from(assets)
    .where(
      and(
        eq(assets.workspaceId, workspaceId),
        inArray(assets.id, [...new Set(pending.map((p) => p.id))]),
      ),
    );
  const assetById = new Map(rows.map((r) => [r.id, r]));

  const advisories: PublishAdvisory[] = [];
  for (const p of pending) {
    const asset = assetById.get(p.id);
    if (!asset || asset.alt !== null) continue;
    advisories.push({
      code: "alt-missing",
      severity: "error",
      field: p.field,
      message: `${p.label ?? p.field}: "${asset.filename}" has no alt text (WCAG 1.1.1)`,
    });
  }
  return advisories;
}
