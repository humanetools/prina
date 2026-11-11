/**
 * `definition` of a content type / component as a shared schema. Commands take it as opaque JSON
 * and validate against the field registry, so the document asks the registry too: one variant
 * per field type, from that type's own `defSchema`.
 */
import type { FieldTypeRegistry } from "../../content/field-types/registry.js";
import { toJsonSchema } from "./json-schema.js";

export function definitionSchemas(registry: FieldTypeRegistry): Record<string, unknown> {
  const variants = registry.list().map((handler) => ({ title: handler.type, ...toJsonSchema(handler.defSchema) }));
  return {
    field_definition: {
      description: "One field of a content type or component. `type` selects the variant.",
      oneOf: variants,
    },
    definition: {
      type: "object",
      required: ["fields"],
      properties: {
        fields: { type: "array", maxItems: 200, items: { $ref: "#/components/schemas/field_definition" } },
        displayField: { type: "string", description: "Field shown as the entry's title in lists and relation pickers" },
      },
    },
  };
}
