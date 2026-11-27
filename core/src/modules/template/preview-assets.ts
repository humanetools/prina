/**
 * Preview assets (43-IMPL) — files the admin previews inline ahead of a template's own css so a
 * preview looks like the site: design-system CSS kept as content (single-type text fields, served to
 * the site through /delivery/<single>/<field>.css — 39-IMPL C4). The workspace setting
 * `previewAssets` lists which fields; each resolves to the field's most recently saved value
 * (drafts included — "fix the CSS, look at the preview" must work before publishing).
 *
 * Delivery is untouched: this exists only for the admin's Shadow DOM previews.
 */
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { ContentTypeKind, FieldType } from "@prina/shared";
import { contentTypes, entries, locales, workspaces } from "../../db/schema/index.js";
import type { CommandCtx } from "../../commands/context.js";

export const previewAssetRefSchema = z.object({
  /** single type uid */
  type: z.string().min(1).max(100),
  /** text field of that type */
  field: z.string().min(1).max(100),
  /** how the preview injects it — css as <style>, svg inlined hidden (icon sprites) */
  as: z.enum(["css", "svg"]).default("css"),
});
export type PreviewAssetRef = z.infer<typeof previewAssetRefSchema>;

export interface PreviewAsset extends PreviewAssetRef {
  /** the field's current text — empty when missing */
  body: string;
  /** set when the type, field or entry could not be found — the preview goes on without it */
  missing?: true;
}

/** The validated `previewAssets` list from the workspace settings (malformed rows dropped) */
export async function loadPreviewAssetRefs(ctx: Pick<CommandCtx, "db" | "workspaceId">): Promise<PreviewAssetRef[]> {
  const [ws] = await ctx.db
    .select({ settings: workspaces.settings })
    .from(workspaces)
    .where(eq(workspaces.id, ctx.workspaceId))
    .limit(1);
  const raw = (ws?.settings as { previewAssets?: unknown } | undefined)?.previewAssets;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((r) => {
    const p = previewAssetRefSchema.safeParse(r);
    return p.success ? [p.data] : [];
  });
}

/** Resolve every configured reference to its current text (latest saved entry, default locale first) */
export async function loadPreviewAssets(ctx: Pick<CommandCtx, "db" | "workspaceId">): Promise<PreviewAsset[]> {
  const refs = await loadPreviewAssetRefs(ctx);
  if (refs.length === 0) return [];
  const [defaultLocale] = await ctx.db
    .select({ code: locales.code })
    .from(locales)
    .where(and(eq(locales.workspaceId, ctx.workspaceId), eq(locales.isDefault, true)))
    .limit(1);
  const out: PreviewAsset[] = [];
  for (const ref of refs) {
    const [type] = await ctx.db
      .select({ id: contentTypes.id, kind: contentTypes.kind, definition: contentTypes.definition })
      .from(contentTypes)
      .where(and(eq(contentTypes.workspaceId, ctx.workspaceId), eq(contentTypes.uid, ref.type)))
      .limit(1);
    const def = type?.definition.fields.find((f) => f.name === ref.field);
    if (!type || type.kind !== ContentTypeKind.Single || !def || def.type !== FieldType.Text) {
      out.push({ ...ref, body: "", missing: true });
      continue;
    }
    const rows = await ctx.db
      .select({ locale: entries.locale, values: entries.values })
      .from(entries)
      .where(eq(entries.contentTypeId, type.id))
      .orderBy(desc(entries.updatedAt))
      .limit(50);
    const pick = rows.find((r) => r.locale === defaultLocale?.code) ?? rows[0];
    const body = pick ? (pick.values as Record<string, unknown>)[ref.field] : undefined;
    if (typeof body !== "string") {
      out.push({ ...ref, body: "", missing: true });
      continue;
    }
    out.push({ ...ref, body });
  }
  return out;
}
