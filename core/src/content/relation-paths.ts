/**
 * Relation fields reachable through components and dynamic zones (hand-off-02, 2026-09-15).
 *
 * `entry_relations` and the relationship graph used to see only a type's top-level relation
 * fields. Once sections moved into `page.sections` (dynamic zone), the `items → product` relations
 * inside the blocks vanished from reverse lookups and the graph. This module is the one place
 * that walks a definition (and its values) through Component / DynamicZone fields.
 *
 * Path notation (stored in entry_relations.field, stable across block order):
 *   top-level            items
 *   component field      hero.author              (hero is a component field; its uid is fixed)
 *   dynamic zone block   sections[blocks.grid].items   (component uid disambiguates blocks)
 */
import { FieldType } from "@prina/shared";
import type {
  ContentTypeDefinition,
  FieldDef,
  RelationFieldDef,
} from "@prina/shared";
import { isToMany } from "./field-types/index.js";

export type ComponentMap = Map<string, ContentTypeDefinition>;

export interface RelationPath {
  path: string;
  def: RelationFieldDef;
  /** Component uid that directly holds the field — null for a top-level field */
  via: string | null;
}

export interface RelationPathValues extends RelationPath {
  /** Target ids in document order (repeated blocks concatenate) */
  ids: string[];
}

const MAX_DEPTH = 4;

/** Every relation field of a definition, including those nested in components / dynamic zones */
export function collectRelationPaths(
  definition: ContentTypeDefinition,
  componentMap: ComponentMap,
): RelationPath[] {
  const out: RelationPath[] = [];
  const walk = (def: ContentTypeDefinition, prefix: string, via: string | null, depth: number) => {
    if (depth > MAX_DEPTH) return;
    for (const field of def.fields) {
      const path = prefix ? `${prefix}.${field.name}` : field.name;
      switch (field.type) {
        case FieldType.Relation:
          out.push({ path, def: field, via });
          break;
        case FieldType.Component: {
          const comp = componentMap.get(field.component);
          if (comp) walk(comp, path, field.component, depth + 1);
          break;
        }
        case FieldType.DynamicZone:
          for (const uid of field.components) {
            const comp = componentMap.get(uid);
            if (comp) walk(comp, `${path}[${uid}]`, uid, depth + 1);
          }
          break;
        default:
          break;
      }
    }
  };
  walk(definition, "", null, 0);
  return out;
}

export function findRelationPath(
  definition: ContentTypeDefinition,
  componentMap: ComponentMap,
  path: string,
): RelationPath | null {
  return collectRelationPaths(definition, componentMap).find((p) => p.path === path) ?? null;
}

function idsOf(def: RelationFieldDef, value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (isToMany(def)) return Array.isArray(value) ? (value as string[]) : [];
  return typeof value === "string" ? [value] : [];
}

/** Relation values of an entry, grouped by path — the input for entry_relations sync */
export function collectRelationValues(
  definition: ContentTypeDefinition,
  values: Record<string, unknown>,
  componentMap: ComponentMap,
): RelationPathValues[] {
  const byPath = new Map<string, RelationPathValues>();
  const push = (path: string, def: RelationFieldDef, via: string | null, ids: string[]) => {
    const row = byPath.get(path) ?? { path, def, via, ids: [] };
    row.ids.push(...ids);
    byPath.set(path, row);
  };
  const walk = (def: ContentTypeDefinition, vals: Record<string, unknown>, prefix: string, via: string | null, depth: number) => {
    if (depth > MAX_DEPTH) return;
    for (const field of def.fields as FieldDef[]) {
      const value = vals[field.name];
      if (value === null || value === undefined) continue;
      const path = prefix ? `${prefix}.${field.name}` : field.name;
      switch (field.type) {
        case FieldType.Relation:
          push(path, field, via, idsOf(field, value));
          break;
        case FieldType.Component: {
          const comp = componentMap.get(field.component);
          if (!comp) break;
          const items = field.repeatable && Array.isArray(value) ? value : [value];
          for (const item of items) {
            if (item && typeof item === "object") walk(comp, item as Record<string, unknown>, path, field.component, depth + 1);
          }
          break;
        }
        case FieldType.DynamicZone: {
          if (!Array.isArray(value)) break;
          for (const block of value) {
            const b = block as Record<string, unknown>;
            const uid = String(b?.__component ?? "");
            const comp = componentMap.get(uid);
            if (comp) walk(comp, b, `${path}[${uid}]`, uid, depth + 1);
          }
          break;
        }
        default:
          break;
      }
    }
  };
  walk(definition, values, "", null, 0);
  return [...byPath.values()];
}

/** Does the definition reach into components at all? Lets callers skip the component lookup */
export function hasNestedFields(definition: ContentTypeDefinition): boolean {
  return definition.fields.some((f) => f.type === FieldType.Component || f.type === FieldType.DynamicZone);
}
