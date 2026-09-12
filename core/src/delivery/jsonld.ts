/**
 * JSON-LD generation (T9.1, §2.7) — derived from populated values + the type's schema.org mapping.
 *
 * Mapping rules (v2 — schema.org vocabulary validation):
 * - @type = schema_org_type(+secondary). Cannot generate without it
 * - name = displayField value, identifier = entry id
 * - Plain fields: emitted only when the field name is a valid schema.org property on @type (ancestors included)
 *   — otherwise **drop** (same rule as the tab's Field→property table)
 * - relation: always emitted when a predicate exists — schema.org properties as-is,
 *   namespaced ones (gs1: etc.) as-is, other custom ones registered in @context under the prina vocab.
 *   Without a predicate, the field name is validated by the plain-field rule
 * - component·dynamic_zone → additionalProperty (only when that property is valid on @type)
 * - json·variant_axis → excluded
 */
import { FieldType } from "@prina/shared";
import type { ContentTypeDefinition, RelationFieldDef } from "@prina/shared";
import type { FieldTypeRegistry } from "../content/field-types/registry.js";
import { isValidProperty } from "./schema-vocab.js";

/** JSON-LD namespace for custom predicates */
const PRINA_VOCAB = "https://prina.dev/vocab#";

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

function relationNode(s: RelSummaryLike): Record<string, unknown> {
  return {
    "@type": s.schemaOrgType ?? "Thing",
    identifier: s.id,
    ...(s.display !== null && s.display !== undefined ? { name: s.display } : {}),
  };
}

function isPlainValue(v: unknown): boolean {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

/** component/DZ values → PropertyValue list (one-level flattening, primitives only) */
function toPropertyValues(
  prefix: string,
  def: ContentTypeDefinition,
  value: unknown,
): Array<Record<string, unknown>> {
  const objects = Array.isArray(value) ? value : [value];
  const out: Array<Record<string, unknown>> = [];
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

export function buildJsonLd(src: JsonLdSource): Record<string, unknown> | null {
  if (!src.schemaOrgType) return null;

  const ld: Record<string, unknown> = {
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

  const additionalProperties: Array<Record<string, unknown>> = [];
  const ldTypes = [src.schemaOrgType, src.schemaOrgSecondary].filter((t): t is string => !!t);
  const customTerms: Record<string, string> = {};
  const plainOk = (prop: string) => isValidProperty(prop, ldTypes);

  for (const field of src.definition.fields) {
    const value = src.populatedValues[field.name];
    if (value === null || value === undefined) continue;
    if (field.name === displayField) continue; // already mapped as name

    switch (field.type) {
      case FieldType.Text:
      case FieldType.Uid:
      case FieldType.Number:
      case FieldType.Boolean:
      case FieldType.Enum:
      case FieldType.Date:
        if (plainOk(field.name)) ld[field.name] = value;
        break;
      case FieldType.Richtext: {
        if (!plainOk(field.name)) break;
        const handler = src.registry.get(field.type);
        const text = handler.extractText?.(field as never, value) ?? "";
        if (text) ld[field.name] = text;
        break;
      }
      case FieldType.Media: {
        if (!plainOk(field.name)) break;
        const urls = (Array.isArray(value) ? value : [value])
          .map((a) => (a as { url?: string })?.url)
          .filter((u): u is string => !!u);
        if (urls.length > 0) ld[field.name] = (field as { multiple?: boolean }).multiple ? urls : urls[0];
        break;
      }
      case FieldType.Relation: {
        const rel = field as RelationFieldDef;
        const predicate = rel.predicate;
        let prop: string | null = null;
        if (predicate) {
          prop = predicate;
          // Register custom (non-namespaced, non-standard) predicates in @context to keep the JSON-LD valid
          if (!predicate.includes(":") && !plainOk(predicate)) {
            customTerms[predicate] = `${PRINA_VOCAB}${predicate}`;
          }
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
        if (!plainOk("additionalProperty")) break;
        const comp = (field as { component: string }).component;
        const def = src.componentDefs.get(comp);
        if (def) additionalProperties.push(...toPropertyValues(field.name, def, value));
        break;
      }
      case FieldType.DynamicZone: {
        if (!plainOk("additionalProperty") || !Array.isArray(value)) break;
        for (const block of value) {
          const uid = String((block as Record<string, unknown>).__component);
          const def = src.componentDefs.get(uid);
          if (def) additionalProperties.push(...toPropertyValues(`${field.name}.${uid}`, def, block));
        }
        break;
      }
      default:
        break; // json·variant_axis excluded
    }
  }

  if (additionalProperties.length > 0) ld.additionalProperty = additionalProperties;

  // Emit inverse edges — predicates other types' relations write back onto this entry via writeInverse
  for (const [prop, nodes] of Object.entries(src.inverseEdges ?? {})) {
    if (nodes.length === 0) continue;
    if (!prop.includes(":") && !plainOk(prop)) {
      customTerms[prop] = `${PRINA_VOCAB}${prop}`;
    }
    ld[prop] = nodes.map(relationNode);
  }

  if (Object.keys(customTerms).length > 0) {
    ld["@context"] = ["https://schema.org", customTerms];
  }
  return ld;
}

/** Whether JSON-LD can be generated from the definition alone (routes use it for 404/empty responses) */
export function canBuildJsonLd(schemaOrgType: string | null): boolean {
  return !!schemaOrgType;
}
