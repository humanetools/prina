/**
 * Variants derivation (T1.6, SPEC §2.8)
 * - On parent save, sync child SKU entries from the option combinations of the variant_axis value.
 * - Child values = overrides only. Effective values are merged with the parent at read time (resolveEffectiveValues)
 *   → parent value edits auto-propagate to non-overridden children (DoD).
 * [decision] When an axis combination is removed, delete that child even if it has overrides —
 * the axis definition (parent values) is the source of truth. Revisit with soft-delete if needed.
 */
import { and, eq } from "drizzle-orm";
import { FieldType } from "@prina/shared";
import type { ContentTypeDefinition, VariantAxisFieldDef } from "@prina/shared";
import { entries } from "../../db/schema/index.js";
import { comboKey, expandVariantCombos } from "../../content/field-types/index.js";
import type { CommandCtx } from "../../commands/context.js";

export type EntryRow = typeof entries.$inferSelect;

export function findVariantAxisField(
  definition: ContentTypeDefinition,
): VariantAxisFieldDef | undefined {
  return definition.fields.find(
    (f): f is VariantAxisFieldDef => f.type === FieldType.VariantAxis,
  );
}

/** Sync child SKUs after parent entry save. Returns: {created, removed, kept} */
export async function syncVariantChildren(
  ctx: CommandCtx,
  definition: ContentTypeDefinition,
  parent: EntryRow,
): Promise<{ created: number; removed: number; kept: number }> {
  const axisField = findVariantAxisField(definition);
  if (!axisField || parent.parentEntryId) return { created: 0, removed: 0, kept: 0 };

  const selection = parent.values[axisField.name] as
    | Record<string, string[]>
    | null
    | undefined;
  const combos = expandVariantCombos(axisField, selection);
  const wanted = new Map(combos.map((c) => [comboKey(c), c]));

  const children = await ctx.db
    .select()
    .from(entries)
    .where(and(eq(entries.workspaceId, ctx.workspaceId), eq(entries.parentEntryId, parent.id)));

  let removed = 0;
  let kept = 0;
  for (const child of children) {
    const key = comboKey(child.variantValues ?? {});
    if (wanted.has(key)) {
      wanted.delete(key);
      kept += 1;
    } else {
      await ctx.db.delete(entries).where(eq(entries.id, child.id));
      removed += 1;
    }
  }

  let created = 0;
  for (const combo of wanted.values()) {
    await ctx.db.insert(entries).values({
      workspaceId: ctx.workspaceId,
      contentTypeId: parent.contentTypeId,
      locale: parent.locale,
      status: "draft",
      values: {},
      variantValues: combo,
      parentEntryId: parent.id,
      createdBy: parent.updatedBy ?? parent.createdBy,
      updatedBy: parent.updatedBy ?? parent.createdBy,
    });
    created += 1;
  }
  return { created, removed, kept };
}

/**
 * Child SKU effective values = parent values (variant_axis field excluded) ⊕ child overrides.
 * For a parent entry, its own values as-is.
 */
export function resolveEffectiveValues(
  definition: ContentTypeDefinition,
  entry: EntryRow,
  parent: EntryRow | null,
): Record<string, unknown> {
  if (!parent) return entry.values;
  const axisField = findVariantAxisField(definition);
  const base: Record<string, unknown> = { ...parent.values };
  if (axisField) delete base[axisField.name];
  return { ...base, ...entry.values };
}
