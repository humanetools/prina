/**
 * Stable block ids for dynamic-zone blocks (39-IMPL).
 *
 * A block is `{ __component, …fields }` stored by position. Authoring canvases need an identity that
 * survives reordering (overlay selection, inline-edit markers `data-blk`, partial re-render), so every
 * block carries `_id`. Ids are assigned here on save when a client did not send one — REST, MCP and
 * the admin all pass through persistEntryValues, so no writer can store an id-less block.
 * Nested zones (a block's component holding another dynamic zone) are walked too.
 */
import { randomUUID } from "node:crypto";
import { DYNAMIC_ZONE_BLOCK_ID, FieldType } from "@prina/shared";
import type { ContentTypeDefinition, FieldDef } from "@prina/shared";
import type { ComponentMap } from "../../content/relation-paths.js";

const MAX_DEPTH = 8;

function newId(taken: Set<string>): string {
  let id = randomUUID().slice(0, 8);
  while (taken.has(id)) id = randomUUID().slice(0, 8);
  taken.add(id);
  return id;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** Returns a copy of `values` where every dynamic-zone block has a unique (per zone) string `_id` */
export function ensureBlockIds(
  definition: ContentTypeDefinition,
  values: Record<string, unknown>,
  componentMap: ComponentMap,
): Record<string, unknown> {
  const walkObject = (
    def: ContentTypeDefinition,
    obj: Record<string, unknown>,
    depth: number,
  ): Record<string, unknown> => {
    if (depth > MAX_DEPTH) return obj;
    let out: Record<string, unknown> | null = null;
    const set = (key: string, v: unknown) => {
      if (!out) out = { ...obj };
      out[key] = v;
    };
    for (const field of def.fields as FieldDef[]) {
      const value = obj[field.name];
      if (value === null || value === undefined) continue;
      if (field.type === FieldType.Component) {
        const comp = componentMap.get(field.component);
        if (!comp) continue;
        if (field.repeatable && Array.isArray(value)) {
          const next = value.map((item) =>
            isObject(item) ? walkObject(comp, item, depth + 1) : item,
          );
          if (next.some((n, i) => n !== value[i])) set(field.name, next);
        } else if (isObject(value)) {
          const next = walkObject(comp, value, depth + 1);
          if (next !== value) set(field.name, next);
        }
      } else if (field.type === FieldType.DynamicZone) {
        if (!Array.isArray(value)) continue;
        const taken = new Set<string>();
        for (const block of value) {
          const id = isObject(block) ? block[DYNAMIC_ZONE_BLOCK_ID] : undefined;
          if (typeof id === "string" && id) taken.add(id);
        }
        let changed = false;
        const next = value.map((block) => {
          if (!isObject(block)) return block;
          let b = block;
          const comp = componentMap.get(String(b.__component ?? ""));
          if (comp) {
            const walked = walkObject(comp, b, depth + 1);
            if (walked !== b) {
              b = walked;
              changed = true;
            }
          }
          const id = b[DYNAMIC_ZONE_BLOCK_ID];
          if (typeof id !== "string" || !id) {
            b = { ...b, [DYNAMIC_ZONE_BLOCK_ID]: newId(taken) };
            changed = true;
          }
          return b;
        });
        if (changed) set(field.name, next);
      }
    }
    return out ?? obj;
  };
  return walkObject(definition, values, 0);
}
