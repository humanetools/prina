/**
 * Relation fields reachable through components / dynamic zones — admin mirror of
 * prina-core/src/content/relation-paths.ts (same path notation; keep in sync).
 *   top-level          items
 *   component field    hero.author
 *   dynamic zone       sections[blocks.grid].items
 */
import { FieldType, type ComponentDef, type ContentTypeDefinition, type FieldDef } from "../../../api/types";

export interface RelationPath {
  path: string;
  def: FieldDef;
  /** Component uid that directly holds the field — null for a top-level field */
  via: string | null;
}

const MAX_DEPTH = 4;

export function collectRelationPaths(
  definition: ContentTypeDefinition,
  components: ComponentDef[] | undefined,
): RelationPath[] {
  const byUid = new Map((components ?? []).map((c) => [c.uid, c.definition]));
  const out: RelationPath[] = [];
  const walk = (def: ContentTypeDefinition, prefix: string, via: string | null, depth: number) => {
    if (depth > MAX_DEPTH) return;
    for (const field of def.fields) {
      const path = prefix ? `${prefix}.${field.name}` : field.name;
      if (field.type === FieldType.Relation) {
        out.push({ path, def: field, via });
      } else if (field.type === FieldType.Component) {
        const uid = field.component as string;
        const comp = byUid.get(uid);
        if (comp) walk(comp, path, uid, depth + 1);
      } else if (field.type === FieldType.DynamicZone) {
        for (const uid of (field.components as string[] | undefined) ?? []) {
          const comp = byUid.get(uid);
          if (comp) walk(comp, `${path}[${uid}]`, uid, depth + 1);
        }
      }
    }
  };
  walk(definition, "", null, 0);
  return out;
}

/* ── Graph model: components as nodes (2026-09-15) ──
 * A type reaches a component through a component field or a dynamic zone ("contains" edge);
 * the component's relation fields then point at target types ("relation" edge from the component
 * node). The dynamic zone itself is not a node — the contains edge carries that information. */

export type GraphNodeId = string; // type uid, or `comp:<component uid>`
export const compNodeId = (uid: string): GraphNodeId => `comp:${uid}`;
export const isCompNode = (id: GraphNodeId): boolean => id.startsWith("comp:");
export const compUidOf = (id: GraphNodeId): string => id.slice(5);

export interface ContainsEdge {
  kind: "contains";
  /** Type uid whose definition this edge belongs to */
  owner: string;
  from: GraphNodeId;
  to: GraphNodeId;
  field: string;
  /** dynamic zone or plain component field */
  through: "zone" | "component";
  /** Path prefix of the container, e.g. `sections[blocks.grid]` */
  path: string;
}

export interface GraphRelationEdge {
  kind: "relation";
  owner: string;
  from: GraphNodeId;
  /** Target type uid */
  to: string;
  def: FieldDef;
  /** Full relation path on the owner type (selection key) */
  path: string;
  via: string | null;
}

export type GraphEdge = ContainsEdge | GraphRelationEdge;

/** All edges a type contributes: its own relations, the components it contains (recursively), and those components' relations */
export function collectTypeGraph(
  typeUid: string,
  definition: ContentTypeDefinition,
  components: ComponentDef[] | undefined,
): GraphEdge[] {
  const byUid = new Map((components ?? []).map((c) => [c.uid, c.definition]));
  const out: GraphEdge[] = [];
  const seenContains = new Set<string>();
  const walk = (def: ContentTypeDefinition, from: GraphNodeId, prefix: string, via: string | null, depth: number) => {
    if (depth > MAX_DEPTH) return;
    for (const field of def.fields) {
      const path = prefix ? `${prefix}.${field.name}` : field.name;
      if (field.type === FieldType.Relation) {
        out.push({ kind: "relation", owner: typeUid, from, to: field.target as string, def: field, path, via });
      } else if (field.type === FieldType.Component) {
        const uid = field.component as string;
        const comp = byUid.get(uid);
        if (!comp) continue;
        const key = `${from}|${field.name}|${uid}`;
        if (!seenContains.has(key)) {
          seenContains.add(key);
          out.push({ kind: "contains", owner: typeUid, from, to: compNodeId(uid), field: field.name, through: "component", path });
        }
        walk(comp, compNodeId(uid), path, uid, depth + 1);
      } else if (field.type === FieldType.DynamicZone) {
        for (const uid of (field.components as string[] | undefined) ?? []) {
          const comp = byUid.get(uid);
          if (!comp) continue;
          const key = `${from}|${field.name}|${uid}`;
          if (!seenContains.has(key)) {
            seenContains.add(key);
            out.push({ kind: "contains", owner: typeUid, from, to: compNodeId(uid), field: field.name, through: "zone", path: `${path}[${uid}]` });
          }
          walk(comp, compNodeId(uid), `${path}[${uid}]`, uid, depth + 1);
        }
      }
    }
  };
  walk(definition, typeUid, "", null, 0);
  return out;
}
