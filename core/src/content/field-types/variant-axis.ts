/**
 * variant_axis field (T1.6, SPEC §2.8)
 * - Definition: axes = [{ name: "Color", options: ["Red","Blue"] }]
 * - Parent entry value: { "Color": ["Red","Blue"] } — subset of options this product actually uses
 * - On save, the service layer derives child SKU entries from the cartesian product of option combos.
 * - Child value inheritance: child values store only overrides; effective values merge with the parent on read.
 */
import { z } from "zod";
import { FieldType } from "@prina/shared";
import type { VariantAxisFieldDef } from "@prina/shared";
import { baseDefShape } from "./base-def.js";
import type { FieldTypeHandler, JsonSchemaObject } from "./registry.js";

export const variantAxisField: FieldTypeHandler<VariantAxisFieldDef> = {
  type: FieldType.VariantAxis,
  defSchema: z.object({
    ...baseDefShape,
    type: z.literal(FieldType.VariantAxis),
    axes: z
      .array(
        z.object({
          name: z.string().min(1).max(100),
          options: z.array(z.string().min(1)).min(1),
        }),
      )
      .min(1),
  }),
  toJsonSchema(def) {
    const properties: Record<string, JsonSchemaObject> = {};
    for (const axis of def.axes) {
      properties[axis.name] = {
        type: "array",
        items: { type: "string", enum: axis.options },
        uniqueItems: true,
      };
    }
    return { type: "object", properties, additionalProperties: false };
  },
};

/** Parent value (axis → selected options) → list of child SKU combos (cartesian product) */
export function expandVariantCombos(
  def: VariantAxisFieldDef,
  value: Record<string, string[]> | null | undefined,
): Array<Record<string, string>> {
  if (!value) return [];
  const axes = def.axes
    .map((a) => ({ name: a.name, options: value[a.name] ?? [] }))
    .filter((a) => a.options.length > 0);
  if (axes.length === 0) return [];
  let combos: Array<Record<string, string>> = [{}];
  for (const axis of axes) {
    combos = combos.flatMap((c) =>
      axis.options.map((opt) => ({ ...c, [axis.name]: opt })),
    );
  }
  return combos;
}

/** Stable key for a combo (for child matching) — sort axis names then serialize */
export function comboKey(combo: Record<string, string>): string {
  return Object.keys(combo)
    .sort()
    .map((k) => `${k}=${combo[k]}`)
    .join("|");
}
