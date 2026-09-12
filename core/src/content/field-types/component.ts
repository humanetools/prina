/**
 * component / dynamic_zone fields (T1.2)
 * - component value: object of field values of the defined component (array if repeatable)
 * - dynamic_zone value: array of [{ __component: uid, ...field values }] — keeps Strapi convention
 * The JSON Schema recursively compiles and inlines component definitions at compile time.
 */
import { z } from "zod";
import { FieldType } from "@prina/shared";
import type { ComponentFieldDef, DynamicZoneFieldDef } from "@prina/shared";
import { baseDefShape } from "./base-def.js";
import type { CompileCtx, FieldTypeHandler, JsonSchemaObject } from "./registry.js";
import { compileDefinitionToObjectSchema } from "../schema-compiler.js";

function componentObjectSchema(uid: string, ctx: CompileCtx): JsonSchemaObject {
  const def = ctx.resolveComponent(uid);
  if (!def) {
    // Component deleted by compile time — make no value pass so it is caught early
    return { not: {}, description: `missing component: ${uid}` };
  }
  return compileDefinitionToObjectSchema(def, ctx);
}

export const componentField: FieldTypeHandler<ComponentFieldDef> = {
  type: FieldType.Component,
  defSchema: z.object({
    ...baseDefShape,
    type: z.literal(FieldType.Component),
    component: z.string().min(1),
    repeatable: z.boolean().optional(),
    min: z.number().int().nonnegative().optional(),
    max: z.number().int().positive().optional(),
  }),
  toJsonSchema(def, ctx) {
    const obj = componentObjectSchema(def.component, ctx);
    if (!def.repeatable) return obj;
    const s: JsonSchemaObject = { type: "array", items: obj };
    if (def.min !== undefined) s.minItems = def.min;
    if (def.max !== undefined) s.maxItems = def.max;
    return s;
  },
};

export const dynamicZoneField: FieldTypeHandler<DynamicZoneFieldDef> = {
  type: FieldType.DynamicZone,
  defSchema: z.object({
    ...baseDefShape,
    type: z.literal(FieldType.DynamicZone),
    /** Empty means a "disabled" zone — definition is kept but no blocks can be added (UI shows inactive) */
    components: z.array(z.string().min(1)).default([]),
    min: z.number().int().nonnegative().optional(),
    max: z.number().int().positive().optional(),
  }),
  toJsonSchema(def, ctx) {
    if (def.components.length === 0) {
      return { type: "array", maxItems: 0 };
    }
    const variants = def.components.map((uid) => {
      const obj = componentObjectSchema(uid, ctx);
      const props = (obj.properties ?? {}) as Record<string, unknown>;
      return {
        ...obj,
        properties: { ...props, __component: { const: uid } },
        required: [...((obj.required as string[] | undefined) ?? []), "__component"],
      };
    });
    const s: JsonSchemaObject = { type: "array", items: { oneOf: variants } };
    if (def.min !== undefined) s.minItems = def.min;
    if (def.max !== undefined) s.maxItems = def.max;
    return s;
  },
};
