/** schema.org combobox candidates + field→JSON-LD property mapping mirror (in sync with server jsonld.ts rules) */
import { FieldType, type ContentTypeDefinition, type FieldDef } from "../../../api/types";

export const SCHEMA_ORG_TYPES: Array<[string, string]> = [
  ["Product", "sellable item — pairs with Offer"],
  ["Offer", "price · availability — usual secondary"],
  ["ProductGroup", "family of product variants"],
  ["Brand", "manufacturer brand"],
  ["Article", "editorial content"],
  ["NewsArticle", "dated news content"],
  ["BlogPosting", "blog entry"],
  ["FAQPage", "page of Question/Answer pairs"],
  ["Question", "single Q&A unit"],
  ["Event", "schedule · location — pairs with Offer"],
  ["Person", "author · staff profile"],
  ["Organization", "company · publisher"],
  ["WebPage", "generic page"],
  ["WebSite", "site root entity"],
  ["CreativeWork", "generic creative fallback"],
  ["ImageObject", "image asset"],
  ["VideoObject", "video asset"],
  ["Review", "rating + review body"],
  ["Recipe", "ingredients · steps"],
  ["Service", "non-physical offering"],
  ["Place", "physical location"],
  ["LocalBusiness", "store · branch — pairs with Place"],
  ["ItemList", "ordered collection"],
  ["HowTo", "step-by-step instructions"],
  ["JobPosting", "recruitment listing"],
  ["SoftwareApplication", "app · SaaS"],
  ["Book", "published book"],
  ["Course", "educational course"],
];

export interface FieldMapRow {
  field: FieldDef;
  /** JSON-LD property name — null means not emitted */
  prop: string | null;
  status: "name" | "valid" | "custom" | "external" | "dropped" | "excluded";
  statusLabel: string;
}

/** Property candidates to send for validation (field name, predicate, additionalProperty) */
export function candidateProps(definition: ContentTypeDefinition): string[] {
  const out = new Set<string>(["additionalProperty"]);
  for (const f of definition.fields) {
    out.add(f.name);
    const p = f.predicate as string | undefined;
    if (p && !p.includes(":")) out.add(p);
  }
  return [...out];
}

/**
 * Mirror of the server buildJsonLd rules — which field is emitted as which property.
 * validMap = /api/schema-org/validate result (property → validity for the selected type)
 */
export function buildFieldMap(
  definition: ContentTypeDefinition,
  primary: string | null,
  validMap: Record<string, boolean> | null,
): FieldMapRow[] {
  const displayField = definition.displayField;
  const ok = (prop: string) => validMap?.[prop] === true;
  const droppedLabel = primary ? `dropped on schema:${primary}` : "no type selected";

  return definition.fields.map((field): FieldMapRow => {
    if (field.name === displayField) {
      return { field, prop: "name", status: "name", statusLabel: "display field → name" };
    }
    switch (field.type) {
      case FieldType.Relation: {
        const predicate = field.predicate as string | undefined;
        if (predicate) {
          if (predicate.includes(":")) {
            return { field, prop: predicate, status: "external", statusLabel: "external vocab — kept" };
          }
          return ok(predicate)
            ? { field, prop: predicate, status: "valid", statusLabel: "valid predicate" }
            : { field, prop: predicate, status: "custom", statusLabel: "custom predicate — kept via @context" };
        }
        return ok(field.name)
          ? { field, prop: field.name, status: "valid", statusLabel: "field name is a valid property" }
          : { field, prop: null, status: "dropped", statusLabel: `no predicate — ${droppedLabel}` };
      }
      case FieldType.Component:
      case FieldType.DynamicZone:
        return ok("additionalProperty")
          ? { field, prop: "additionalProperty", status: "valid", statusLabel: "flattened to PropertyValue" }
          : { field, prop: null, status: "dropped", statusLabel: `additionalProperty ${droppedLabel}` };
      case FieldType.Json:
      case FieldType.VariantAxis:
        return { field, prop: null, status: "excluded", statusLabel: "never emitted" };
      default:
        return ok(field.name)
          ? { field, prop: field.name, status: "valid", statusLabel: "emitted" }
          : { field, prop: null, status: "dropped", statusLabel: droppedLabel };
    }
  });
}
