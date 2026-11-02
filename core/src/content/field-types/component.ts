/**
 * component / dynamic_zone fields (T1.2)
 * - component value: object of field values of the defined component (array if repeatable)
 * - dynamic_zone value: array of [{ __component: uid, ...field values }] — keeps Strapi convention
 * The JSON Schema recursively compiles and inlines component definitions at compile time.
 */
import { z } from "zod";
import { DYNAMIC_ZONE_BLOCK_ID, DYNAMIC_ZONE_DEFAULT_MAX_DEPTH, FieldType } from "@prina/shared";
import type { ComponentFieldDef, DynamicZoneFieldDef } from "@prina/shared";
import { baseDefShape } from "./base-def.js";
import type { CompileCtx, FieldTypeHandler, JsonSchemaObject } from "./registry.js";
import { compileDefinitionToObjectSchema } from "../schema-compiler.js";

/**
 * Components may nest (39-IMPL: a component holds components / dynamic zones), so a definition
 * can reference itself. Compilation stops at this depth — values that deep are rejected.
 */
const MAX_COMPONENT_DEPTH = 8;

function componentObjectSchema(uid: string, ctx: CompileCtx): JsonSchemaObject {
  const def = ctx.resolveComponent(uid);
  if (!def) {
    // Component deleted by compile time — make no value pass so it is caught early
    return { not: {}, description: `missing component: ${uid}` };
  }
  const depth = ctx.depth ?? 0;
  if (depth >= MAX_COMPONENT_DEPTH) {
    return { not: {}, description: `component nesting deeper than ${MAX_COMPONENT_DEPTH}` };
  }
  return compileDefinitionToObjectSchema(def, { ...ctx, depth: depth + 1 });
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
    /** JSON-LD property on the parent node (41-IMPL) */
    predicate: z.string().min(1).max(120).optional(),
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
    maxDepth: z.number().int().min(1).max(MAX_COMPONENT_DEPTH).optional(),
    locked: z.boolean().optional(),
    /** JSON-LD property on the parent node (41-IMPL) */
    predicate: z.string().min(1).max(120).optional(),
  }),
  toJsonSchema(def, ctx) {
    if (def.components.length === 0) {
      return { type: "array", maxItems: 0 };
    }
    // Nesting (39-IMPL): zone depth counts zones only — the first zone of a type is depth 1 and its
    // maxDepth bounds every zone beneath it (nested zones inherit the limit). Beyond the limit a zone
    // must stay empty, so a cyclic component graph still compiles.
    const zoneDepth = (ctx.zoneDepth ?? 0) + 1;
    const zoneMaxDepth = ctx.zoneMaxDepth ?? def.maxDepth ?? DYNAMIC_ZONE_DEFAULT_MAX_DEPTH;
    if (zoneDepth > zoneMaxDepth) {
      return { type: "array", maxItems: 0, description: "dynamic zone nesting depth exceeded" };
    }
    const variants = def.components.map((uid) => {
      const obj = componentObjectSchema(uid, { ...ctx, zoneDepth, zoneMaxDepth });
      const props = (obj.properties ?? {}) as Record<string, unknown>;
      return {
        ...obj,
        properties: {
          ...props,
          __component: { const: uid },
          // Stable block id (39-IMPL) — assigned on save when absent; authoring canvases key on it
          [DYNAMIC_ZONE_BLOCK_ID]: { type: "string", minLength: 1, maxLength: 64 },
        },
        required: [...((obj.required as string[] | undefined) ?? []), "__component"],
      };
    });
    const s: JsonSchemaObject = { type: "array", items: { oneOf: variants } };
    if (def.min !== undefined) s.minItems = def.min;
    if (def.max !== undefined) s.maxItems = def.max;
    return s;
  },
};
