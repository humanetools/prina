/**
 * relation values → entry_relations normalization (consumes T1.1's predicate column)
 * The relation fields in values JSONB are the source of truth; entry_relations is
 * a derived index for reverse lookups and KG (Phase 9). Fully resynced on every save.
 */
import { and, eq, inArray } from "drizzle-orm";
import { FieldType } from "@prina/shared";
import type { ContentTypeDefinition, RelationFieldDef } from "@prina/shared";
import { entryRelations } from "../../db/schema/index.js";
import { isToMany } from "../../content/field-types/index.js";
import type { CommandCtx } from "../../commands/context.js";
import type { EntryRow } from "./variants.js";

export async function syncEntryRelations(
  ctx: CommandCtx,
  definition: ContentTypeDefinition,
  entry: EntryRow,
): Promise<void> {
  const relationFields = definition.fields.filter(
    (f): f is RelationFieldDef => f.type === FieldType.Relation,
  );
  if (relationFields.length === 0) return;

  await ctx.db
    .delete(entryRelations)
    .where(
      and(
        eq(entryRelations.fromEntryId, entry.id),
        inArray(
          entryRelations.field,
          relationFields.map((f) => f.name),
        ),
      ),
    );

  const rows: (typeof entryRelations.$inferInsert)[] = [];
  for (const field of relationFields) {
    const value = entry.values[field.name];
    if (value === null || value === undefined) continue;
    const ids = isToMany(field) ? (value as string[]) : [value as string];
    ids.forEach((toEntryId, position) => {
      rows.push({
        workspaceId: ctx.workspaceId,
        fromEntryId: entry.id,
        toEntryId,
        field: field.name,
        predicate: field.predicate ?? null, // KG slot (absolute principle 5)
        position,
      });
    });
  }
  if (rows.length > 0) await ctx.db.insert(entryRelations).values(rows);
}
