/**
 * relation values → entry_relations normalization (consumes T1.1's predicate column)
 * The relation fields in values JSONB are the source of truth; entry_relations is
 * a derived index for reverse lookups and KG (Phase 9). Fully resynced on every save.
 * Relations nested in components / dynamic zones are indexed too (hand-off-02) — `field`
 * holds the path from content/relation-paths.ts (e.g. `sections[blocks.grid].items`).
 */
import { eq } from "drizzle-orm";
import type { ContentTypeDefinition } from "@prina/shared";
import { entryRelations } from "../../db/schema/index.js";
import { collectRelationValues, hasNestedFields } from "../../content/relation-paths.js";
import { loadComponentMap } from "../content-type/repo.js";
import type { CommandCtx } from "../../commands/context.js";
import type { EntryRow } from "./variants.js";

export async function syncEntryRelations(
  ctx: CommandCtx,
  definition: ContentTypeDefinition,
  entry: EntryRow,
): Promise<void> {
  const componentMap = hasNestedFields(definition)
    ? await loadComponentMap(ctx.db, ctx.workspaceId)
    : new Map();
  const groups = collectRelationValues(definition, entry.values as Record<string, unknown>, componentMap);

  // Values are the source of truth — drop every row this entry emitted before (fields that left
  // the definition included) and rebuild.
  await ctx.db.delete(entryRelations).where(eq(entryRelations.fromEntryId, entry.id));

  const rows: (typeof entryRelations.$inferInsert)[] = [];
  for (const g of groups) {
    g.ids.forEach((toEntryId, position) => {
      rows.push({
        workspaceId: ctx.workspaceId,
        fromEntryId: entry.id,
        toEntryId,
        field: g.path,
        predicate: g.def.predicate ?? null, // KG slot (absolute principle 5)
        position,
      });
    });
  }
  if (rows.length > 0) await ctx.db.insert(entryRelations).values(rows);
}
