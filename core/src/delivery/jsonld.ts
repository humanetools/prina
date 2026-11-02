/**
 * JSON-LD generation (T9.1, §2.7) — derived from populated values + the type's schema.org mapping.
 *
 * Mapping rules (v3 — nested nodes, 41-IMPL):
 * - @type = schema_org_type(+secondary). Cannot generate without it
 * - name = displayField value, identifier = entry id
 * - Plain fields: `semantic.properties[name]` wins; otherwise emitted only when the field name is a valid
 *   schema.org property on @type (ancestors included) — otherwise **drop** (same rule as the tab's
 *   Field→property table). `semantic.wrap[name]` wraps the literal in a node ({ @type, valueProperty })
 * - relation: always emitted when a predicate exists — schema.org properties as-is,
 *   namespaced ones (gs1: etc.) as-is, other custom ones registered in @context under the prina vocab.
 *   Without a predicate, the field name is validated by the plain-field rule
 * - component·dynamic_zone WITH a `predicate`: each value becomes a node of its component (the
 *   component's `definition.semantic.schemaOrgType`, same field rules recursively) under that property.
 *   A component without a node type is a wrapper: its mapped child edges are hoisted onto the parent
 * - component·dynamic_zone WITHOUT a predicate → additionalProperty (legacy flattening, only when valid on @type)
 * - json·variant_axis → excluded
 */
import { FieldType } from "@prina/shared";
import type { ContentTypeDefinition, RelationFieldDef, SemanticMapping } from "@prina/shared";
import type { FieldTypeRegistry } from "../content/field-types/registry.js";
import { isValidProperty } from "./schema-vocab.js";

/** JSON-LD namespace for custom predicates */
const PRINA_VOCAB = "https://prina.dev/vocab#";
/** Component nesting the builder follows — same bound as relation-paths */
const MAX_NODE_DEPTH = 4;

interface JsonLdSource {
  schemaOrgType: string | null;
  /** Secondary type — when present, @type becomes a [primary, secondary] array */
  schemaOrgSecondary?: string | null;
  definition: ContentTypeDefinition;
  entryId: string;
  /** Values passed through populateValuesList (relation·media replaced with summary objects) */
  populatedValues: Record<string, unknown>;
  registry: FieldTypeRegistry;
  componentDefs: Map<string, ContentTypeDefinition>;
  /** Inverse edges (collectInverseEdges result) — inversePredicate → source nodes */
  inverseEdges?: Record<string, RelSummaryLike[]>;
}

interface RelSummaryLike {
  id: string;
  display: unknown;
  schemaOrgType: string | null;
}

type Node = Record<string, unknown>;

interface BuildCtx {
  registry: FieldTypeRegistry;
  componentDefs: Map<string, ContentTypeDefinition>;
  customTerms: Record<string, string>;
}

function relationNode(s: RelSummaryLike): Node {
  return {
    "@type": s.schemaOrgType ?? "Thing",
    identifier: s.id,
    ...(s.display !== null && s.display !== undefined ? { name: s.display } : {}),
  };
}

function isPlainValue(v: unknown): boolean {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

/** component/DZ values → PropertyValue list (one-level flattening, primitives only) — legacy path */
function toPropertyValues(prefix: string, def: ContentTypeDefinition, value: unknown): Node[] {
  const objects = Array.isArray(value) ? value : [value];
  const out: Node[] = [];
  for (const obj of objects) {
    if (obj === null || typeof obj !== "object") continue;
    for (const field of def.fields) {
      const v = (obj as Record<string, unknown>)[field.name];
      if (!isPlainValue(v)) continue;
      out.push({ "@type": "PropertyValue", name: `${prefix}.${field.name}`, value: v });
    }
  }
  return out;
}

/** Append a node or a list of nodes under a property, merging with what is already there */
function attach(target: Node, prop: string, nodes: Node[], asList: boolean) {
  if (nodes.length === 0) return;
  const existing = target[prop];
  if (existing === undefined) {
    target[prop] = asList || nodes.length > 1 ? nodes : nodes[0];
    return;
  }
  const list = Array.isArray(existing) ? (existing as Node[]) : [existing as Node];
  target[prop] = [...list, ...nodes];
}

/**
 * The property a mapped name resolves to on the given node types: standard when valid, kept as-is
 * when namespaced, registered under the prina vocab otherwise (same rule as relation predicates).
 */
function resolveProp(name: string, nodeTypes: string[], ctx: BuildCtx): string {
  if (!name.includes(":") && !isValidProperty(name, nodeTypes)) {
    ctx.customTerms[name] = `${PRINA_VOCAB}${name}`;
  }
  return name;
}

/**
 * One value of a component field / one dynamic-zone block → JSON-LD nodes to attach on the parent.
 * Returns `{ nodes }` for a typed component, or `{ hoisted }` for a wrapper without a node type:
 * the wrapper's own mapped component/zone edges, evaluated against the parent's types.
 */
function blockNodes(
  uid: string,
  obj: unknown,
  parentTypes: string[],
  ctx: BuildCtx,
  depth: number,
): { nodes: Node[]; hoisted: Node } {
  const empty = { nodes: [] as Node[], hoisted: {} as Node };
  if (obj === null || typeof obj !== "object" || depth > MAX_NODE_DEPTH) return empty;
  const def = ctx.componentDefs.get(uid);
  if (!def) return empty;
  const sem = def.semantic;
  const values = obj as Record<string, unknown>;
  if (sem?.schemaOrgType) {
    const types = [sem.schemaOrgType, sem.secondary].filter((t): t is string => !!t);
    const node: Node = { "@type": types.length > 1 ? types : types[0] };
    emitFields(node, def, values, types, ctx, depth + 1);
    return { nodes: [node], hoisted: {} };
  }
  // Wrapper: no node of its own — only its component/zone fields with a predicate contribute, on the parent
  const hoisted: Node = {};
  for (const field of def.fields) {
    if (field.type !== FieldType.Component && field.type !== FieldType.DynamicZone) continue;
    const predicate = (field as { predicate?: string }).predicate;
    if (!predicate) continue;
    emitEdge(hoisted, field, values[field.name], predicate, parentTypes, ctx, depth + 1);
  }
  return { nodes: [], hoisted };
}

/** A component/zone field with a predicate → nodes under that property on `target` */
function emitEdge(
  target: Node,
  field: { type: FieldType; name: string; component?: string },
  value: unknown,
  predicate: string,
  nodeTypes: string[],
  ctx: BuildCtx,
  depth: number,
) {
  if (value === null || value === undefined) return;
  const prop = resolveProp(predicate, nodeTypes, ctx);
  const asList = Array.isArray(value);
  const items = asList ? (value as unknown[]) : [value];
  const nodes: Node[] = [];
  for (const item of items) {
    const uid =
      field.type === FieldType.DynamicZone
        ? String((item as Record<string, unknown> | null)?.__component ?? "")
        : String(field.component ?? "");
    const out = blockNodes(uid, item, nodeTypes, ctx, depth);
    nodes.push(...out.nodes);
    for (const [p, v] of Object.entries(out.hoisted)) {
      attach(target, p, Array.isArray(v) ? (v as Node[]) : [v as Node], Array.isArray(v));
    }
  }
  attach(target, prop, nodes, asList);
}

/** Field loop shared by the root entry and every component node */
function emitFields(
  ld: Node,
  def: ContentTypeDefinition,
  values: Record<string, unknown>,
  ldTypes: string[],
  ctx: BuildCtx,
  depth: number,
) {
  const sem: SemanticMapping | undefined = def.semantic;
  const displayField = depth === 0 ? def.displayField : undefined;
  const plainOk = (prop: string) => isValidProperty(prop, ldTypes);
  // Mapped name for a plain field: explicit property, else the field name when it is a valid property
  const plainProp = (name: string): string | null => {
    const mapped = sem?.properties?.[name];
    if (mapped) return resolveProp(mapped, ldTypes, ctx);
    return plainOk(name) ? name : null;
  };
  const putPlain = (name: string, value: unknown) => {
    const w = sem?.wrap?.[name];
    if (w) {
      const prop = resolveProp(w.property, ldTypes, ctx);
      const wrapped: Node = { "@type": w.schemaOrgType, [w.valueProperty]: value };
      attach(ld, prop, [wrapped], false);
      return;
    }
    const prop = plainProp(name);
    if (prop) ld[prop] = value;
  };
  const additionalProperties: Node[] = [];

  for (const field of def.fields) {
    const value = values[field.name];
    if (value === null || value === undefined) continue;
    if (field.name === displayField) continue; // already mapped as name

    switch (field.type) {
      case FieldType.Text:
      case FieldType.Uid:
      case FieldType.Number:
      case FieldType.Boolean:
      case FieldType.Enum:
      case FieldType.Date:
        putPlain(field.name, value);
        break;
      case FieldType.Richtext: {
        if (!plainProp(field.name) && !sem?.wrap?.[field.name]) break;
        const handler = ctx.registry.get(field.type);
        const text = handler.extractText?.(field as never, value) ?? "";
        if (text) putPlain(field.name, text);
        break;
      }
      case FieldType.Media: {
        if (!plainProp(field.name) && !sem?.wrap?.[field.name]) break;
        const urls = (Array.isArray(value) ? value : [value])
          .map((a) => (a as { url?: string })?.url)
          .filter((u): u is string => !!u);
        if (urls.length > 0) putPlain(field.name, (field as { multiple?: boolean }).multiple ? urls : urls[0]);
        break;
      }
      case FieldType.Relation: {
        const rel = field as RelationFieldDef;
        const predicate = rel.predicate;
        let prop: string | null = null;
        if (predicate) {
          prop = resolveProp(predicate, ldTypes, ctx);
        } else if (plainOk(field.name)) {
          prop = field.name;
        }
        if (!prop) break;
        const summaries = (Array.isArray(value) ? value : [value]) as RelSummaryLike[];
        const nodes = summaries.filter((s) => s && s.id).map(relationNode);
        if (nodes.length > 0) ld[prop] = Array.isArray(value) ? nodes : nodes[0];
        break;
      }
      case FieldType.Component: {
        const predicate = (field as { predicate?: string }).predicate;
        if (predicate) {
          emitEdge(ld, field as { type: FieldType; name: string; component?: string }, value, predicate, ldTypes, ctx, depth);
          break;
        }
        if (!plainOk("additionalProperty")) break;
        const comp = (field as { component: string }).component;
        const cdef = ctx.componentDefs.get(comp);
        if (cdef) additionalProperties.push(...toPropertyValues(field.name, cdef, value));
        break;
      }
      case FieldType.DynamicZone: {
        const predicate = (field as { predicate?: string }).predicate;
        if (predicate) {
          emitEdge(ld, field as { type: FieldType; name: string }, value, predicate, ldTypes, ctx, depth);
          break;
        }
        if (!plainOk("additionalProperty") || !Array.isArray(value)) break;
        for (const block of value) {
          const uid = String((block as Record<string, unknown>).__component);
          const cdef = ctx.componentDefs.get(uid);
          if (cdef) additionalProperties.push(...toPropertyValues(`${field.name}.${uid}`, cdef, block));
        }
        break;
      }
      default:
        break; // json·variant_axis excluded
    }
  }

  if (additionalProperties.length > 0) {
    attach(ld, "additionalProperty", additionalProperties, true);
  }
}

export function buildJsonLd(src: JsonLdSource): Record<string, unknown> | null {
  if (!src.schemaOrgType) return null;

  const ld: Node = {
    "@context": "https://schema.org",
    "@type": src.schemaOrgSecondary
      ? [src.schemaOrgType, src.schemaOrgSecondary]
      : src.schemaOrgType,
    identifier: src.entryId,
  };
  const displayField = src.definition.displayField;
  if (displayField && src.populatedValues[displayField] !== undefined) {
    ld.name = src.populatedValues[displayField];
  }

  const ldTypes = [src.schemaOrgType, src.schemaOrgSecondary].filter((t): t is string => !!t);
  const ctx: BuildCtx = { registry: src.registry, componentDefs: src.componentDefs, customTerms: {} };
  emitFields(ld, src.definition, src.populatedValues, ldTypes, ctx, 0);

  // Emit inverse edges — predicates other types' relations write back onto this entry via writeInverse
  for (const [prop, nodes] of Object.entries(src.inverseEdges ?? {})) {
    if (nodes.length === 0) continue;
    ld[resolveProp(prop, ldTypes, ctx)] = nodes.map(relationNode);
  }

  if (Object.keys(ctx.customTerms).length > 0) {
    ld["@context"] = ["https://schema.org", ctx.customTerms];
  }
  return ld;
}

/** Whether JSON-LD can be generated from the definition alone (routes use it for 404/empty responses) */
export function canBuildJsonLd(schemaOrgType: string | null): boolean {
  return !!schemaOrgType;
}
