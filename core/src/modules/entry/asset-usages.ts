/**
 * Usage tracking sync (T4.3) — on entry save, scan media fields and richtext references
 * and fully resync asset_usages. Source data for deletion protection.
 * [scope note] Top-level fields + richtext body. Media inside component/dynamic_zone is
 * out of v1 scope (add recursive scanning when a preset placing media in a component appears).
 */
import { and, eq, inArray } from "drizzle-orm";
import type { ContentTypeDefinition } from "@prina/shared";
import { assets, assetUsages } from "../../db/schema/index.js";
import type { CommandCtx } from "../../commands/context.js";
import type { EntryRow } from "./variants.js";

export function collectAssetRefs(
  ctx: CommandCtx,
  definition: ContentTypeDefinition,
  values: Record<string, unknown>,
): Array<{ field: string; assetId: string }> {
  const refs: Array<{ field: string; assetId: string }> = [];
  for (const field of definition.fields) {
    const handler = ctx.services.registry.get(field.type);
    if (!handler.extractAssetIds) continue;
    for (const assetId of handler.extractAssetIds(field as never, values[field.name])) {
      refs.push({ field: field.name, assetId });
    }
  }
  return refs;
}

export async function syncAssetUsages(
  ctx: CommandCtx,
  definition: ContentTypeDefinition,
  entry: EntryRow,
): Promise<void> {
  const refs = collectAssetRefs(ctx, definition, entry.values);
  await ctx.db.delete(assetUsages).where(eq(assetUsages.entryId, entry.id));
  if (refs.length === 0) return;

  // References inside richtext skip schema validation, so record only existing assets (FK protection)
  const ids = [...new Set(refs.map((r) => r.assetId))];
  const existingRows = await ctx.db
    .select({ id: assets.id })
    .from(assets)
    .where(and(eq(assets.workspaceId, ctx.workspaceId), inArray(assets.id, ids)));
  const existing = new Set(existingRows.map((r) => r.id));

  // Duplicate references to the same asset in the same field collapse to one row (matches unique constraint)
  const unique = new Map(
    refs
      .filter((r) => existing.has(r.assetId))
      .map((r) => [`${r.assetId}:${r.field}`, r]),
  );
  if (unique.size === 0) return;
  await ctx.db.insert(assetUsages).values(
    [...unique.values()].map((r) => ({
      workspaceId: ctx.workspaceId,
      assetId: r.assetId,
      entryId: entry.id,
      field: r.field,
    })),
  );
}
