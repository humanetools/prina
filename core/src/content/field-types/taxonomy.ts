/**
 * taxonomy field (44-IMPL) — value = taxonomy node id (uuid) or array of uuids. A content type or component
 * says which classification node(s) it is about (a menu block → the `gnb` tree, a card list → a product line).
 * The stored value is a reference only, like a relation; `?populate=1` resolves it to the node with its
 * subtree (`depth` levels) — see modules/delivery/populate.ts. No template-side queries: whatever a
 * template can see is in the delivery JSON too (hand-off-09 headless rule).
 */
import { z } from "zod";
import { FieldType } from "@prina/shared";
import type { TaxonomyFieldDef } from "@prina/shared";
import { baseDefShape } from "./base-def.js";
import type { FieldTypeHandler } from "./registry.js";

const UUID = { type: "string", format: "uuid" };
export const TAXONOMY_FIELD_MAX_DEPTH = 5;

export function taxonomyNodeIds(def: TaxonomyFieldDef, value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (def.multiple) return Array.isArray(value) ? (value as string[]) : [];
  return typeof value === "string" ? [value] : [];
}

export const taxonomyField: FieldTypeHandler<TaxonomyFieldDef> = {
  type: FieldType.Taxonomy,
  defSchema: z.object({
    ...baseDefShape,
    type: z.literal(FieldType.Taxonomy),
    /** Taxonomy uid the nodes must belong to */
    taxonomy: z.string().min(1).max(100),
    multiple: z.boolean().optional(),
    /** populate: how many levels of children to inline under each node (0 = the node only) */
    depth: z.number().int().min(0).max(TAXONOMY_FIELD_MAX_DEPTH).optional(),
  }),
  toJsonSchema(def) {
    return def.multiple ? { type: "array", items: UUID } : { ...UUID };
  },
  async validateValue(def, value, ctx) {
    const ids = taxonomyNodeIds(def, value);
    if (ids.length === 0) return [];
    const existing = await ctx.findExistingTaxonomyNodeIds(def.taxonomy, ids);
    return ids
      .filter((id) => !existing.has(id))
      .map((id) => `${def.name}: node ${id} does not exist in taxonomy '${def.taxonomy}'`);
  },
};
