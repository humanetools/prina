/**
 * Taxonomy attributes (33-IMPL) — field definitions live on the taxonomy, values on each node.
 * Validation is by hand (three scalar types), no JSON-schema compile: the definition is tiny and
 * changes rarely, and a wrong value must say which attribute it is.
 */
import { z } from "zod";
import { TaxonomyAttributeType, type TaxonomyAttributeField } from "@prina/shared";
import { ValidationError } from "../../lib/errors.js";

export const attributeFieldSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, "snake_case, starting with a letter"),
  label: z.string().trim().min(1).max(200).optional(),
  type: z.nativeEnum(TaxonomyAttributeType),
  multiline: z.boolean().optional(),
});

/** ≤ 50 fields, unique names */
export const attributeFieldsSchema = z
  .array(attributeFieldSchema)
  .max(50)
  .superRefine((fields, ctx) => {
    const seen = new Set<string>();
    for (const f of fields) {
      if (seen.has(f.name)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate attribute '${f.name}'` });
      seen.add(f.name);
    }
  });

/**
 * Values for one node, checked against the taxonomy's fields. Unknown keys and wrong types are
 * rejected; null / undefined clears. Returns the object to store (only defined fields, no nulls).
 */
export function validateNodeAttributes(fields: TaxonomyAttributeField[], input: Record<string, unknown>): Record<string, unknown> {
  const byName = new Map(fields.map((f) => [f.name, f]));
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const field = byName.get(key);
    if (!field) throw new ValidationError(`Unknown attribute '${key}' — define it on the taxonomy first`);
    if (value === null || value === undefined) continue;
    switch (field.type) {
      case TaxonomyAttributeType.Text:
        if (typeof value !== "string") throw new ValidationError(`Attribute '${key}' must be a string`);
        if (value.length > 10_000) throw new ValidationError(`Attribute '${key}' is longer than 10,000 characters`);
        break;
      case TaxonomyAttributeType.Number:
        if (typeof value !== "number" || !Number.isFinite(value)) throw new ValidationError(`Attribute '${key}' must be a number`);
        break;
      case TaxonomyAttributeType.Boolean:
        if (typeof value !== "boolean") throw new ValidationError(`Attribute '${key}' must be true or false`);
        break;
    }
    out[key] = value;
  }
  return out;
}

/** Drop values whose field no longer exists — run when a taxonomy's fields change */
export function pruneNodeAttributes(fields: TaxonomyAttributeField[], values: Record<string, unknown>): Record<string, unknown> {
  const keep = new Set(fields.map((f) => f.name));
  return Object.fromEntries(Object.entries(values).filter(([k]) => keep.has(k)));
}
