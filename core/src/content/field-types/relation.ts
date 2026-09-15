/**
 * relation field (T1.2) — value = target entry id (uuid) or array of uuids.
 * On save, the service layer normalizes (syncs) into the entry_relations table.
 * predicate is the KG slot (absolute principle 5) — v1 only stores it.
 */
import { z } from "zod";
import { FieldType } from "@prina/shared";
import type { RelationFieldDef } from "@prina/shared";
import { baseDefShape } from "./base-def.js";
import type { FieldTypeHandler } from "./registry.js";

const UUID = { type: "string", format: "uuid" };

export function isToMany(def: RelationFieldDef): boolean {
  return def.relationKind === "oneToMany" || def.relationKind === "manyToMany";
}

export const relationField: FieldTypeHandler<RelationFieldDef> = {
  type: FieldType.Relation,
  defSchema: z.object({
    ...baseDefShape,
    type: z.literal(FieldType.Relation),
    target: z.string().min(1),
    relationKind: z.enum(["oneToOne", "oneToMany", "manyToOne", "manyToMany"]),
    predicate: z.string().max(200).optional(),
    /** Inverse predicate — when writeInverse is on, emitted in reverse under this name in the target entry's JSON-LD (T9.1) */
    inversePredicate: z.string().max(200).optional(),
    writeInverse: z.boolean().optional(),
  }),
  toJsonSchema(def) {
    return isToMany(def) ? { type: "array", items: UUID } : { ...UUID };
  },
  async validateValue(def, value, ctx) {
    if (value === null || value === undefined) return [];
    const ids = isToMany(def) ? (value as string[]) : [value as string];
    if (ids.length === 0) return [];
    const existing = await ctx.findExistingEntryIds(def.target, ids);
    return ids
      .filter((id) => !existing.has(id))
      .map((id) => `${def.name}: entry ${id} does not exist in target type '${def.target}'`);
  },
};
