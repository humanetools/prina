/** Content type/component definition (CTB input) validation (T1.2 defSchema consumer) */
import { z } from "zod";
import type { ContentTypeDefinition, FieldDef } from "@prina/shared";
import { FieldType } from "@prina/shared";
import type { FieldTypeRegistry } from "./field-types/registry.js";
import { ValidationError } from "../lib/errors.js";

const definitionShape = z.object({
  fields: z.array(z.record(z.unknown())).max(200),
  displayField: z.string().optional(),
  /**
   * Edition namespace (e.g. ee.chatbot.excluded) — core stores it opaquely. The validator
   * rebuilds the definition object below, so without this passthrough every definition save
   * would silently strip EE per-type flags (10-IMPL-chatbot §4.0a).
   */
  ee: z.record(z.unknown()).optional(),
});

/**
 * Names AI agents (and Strapi users) almost always try first, mapped to the real type.
 * Policy: hint only, never silently accept — a silent alias would make the stored
 * definition differ from what the caller wrote, and typo'd types should stay visible.
 */
const TYPE_HINTS: Record<string, FieldType> = {
  string: FieldType.Text,
  longtext: FieldType.Text,
  email: FieldType.Text,
  url: FieldType.Text,
  integer: FieldType.Number,
  float: FieldType.Number,
  decimal: FieldType.Number,
  datetime: FieldType.Date,
  timestamp: FieldType.Date,
  select: FieldType.Enum,
  enumeration: FieldType.Enum,
  image: FieldType.Media,
  file: FieldType.Media,
  video: FieldType.Media,
  slug: FieldType.Uid,
  markdown: FieldType.Richtext,
  html: FieldType.Richtext,
};

/** Minimal valid shape, returned with shape errors so the caller can self-correct in one round trip */
const EXPECTED_SKELETON = {
  fields: [
    { name: "title", type: "text", required: true },
    { name: "status", type: "enum", options: ["draft", "final"] },
    { name: "brand", type: "relation", target: "brand", relationKind: "manyToOne" },
  ],
  displayField: "title",
};

export interface DefinitionValidationOptions {
  /** component definitions forbid variant_axis and nested components */
  isComponent?: boolean;
}

export function validateDefinition(
  registry: FieldTypeRegistry,
  raw: unknown,
  opts: DefinitionValidationOptions = {},
): ContentTypeDefinition {
  const allowedTypes = registry.list().map((h) => h.type);
  const shaped = definitionShape.safeParse(raw);
  if (!shaped.success) {
    throw new ValidationError("Invalid definition format", {
      issues: shaped.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      expected: EXPECTED_SKELETON,
      allowedTypes,
    });
  }

  const issues: string[] = [];
  const fields: FieldDef[] = [];
  const seen = new Set<string>();
  let variantAxisCount = 0;

  for (const [idx, rawField] of shaped.data.fields.entries()) {
    const type = rawField.type as string;
    if (!registry.has(type)) {
      const hint = TYPE_HINTS[type];
      issues.push(
        `fields[${idx}]: unknown field type '${type}'${hint ? ` — did you mean '${hint}'?` : ""}`,
      );
      continue;
    }
    const parsed = registry.get(type).defSchema.safeParse(rawField);
    if (!parsed.success) {
      issues.push(
        ...parsed.error.issues.map(
          (i) => `fields[${idx}].${i.path.join(".")}: ${i.message}`,
        ),
      );
      continue;
    }
    const field = parsed.data as FieldDef;
    if (seen.has(field.name)) {
      issues.push(`fields[${idx}]: duplicate field name '${field.name}'`);
      continue;
    }
    seen.add(field.name);

    if (field.type === FieldType.VariantAxis) {
      variantAxisCount += 1;
      if (opts.isComponent) issues.push(`fields[${idx}]: a component cannot contain a variant_axis`);
    }
    if (opts.isComponent && (field.type === FieldType.Component || field.type === FieldType.DynamicZone)) {
      issues.push(`fields[${idx}]: nesting component/dynamic_zone inside a component is not supported`);
    }
    fields.push(field);
  }

  if (variantAxisCount > 1) {
    issues.push("At most one variant_axis field per type");
  }
  for (const [idx, field] of fields.entries()) {
    if (field.type !== FieldType.Uid) continue;
    const target = (field as { targetField?: string }).targetField;
    if (!target) continue;
    const source = fields.find((f) => f.name === target);
    if (!source) {
      issues.push(`fields[${idx}]: uid targetField '${target}' is not in the field list`);
    } else if (source.type !== FieldType.Text) {
      issues.push(`fields[${idx}]: uid targetField '${target}' must be a text field`);
    }
  }
  const displayField = shaped.data.displayField;
  if (displayField && !seen.has(displayField)) {
    issues.push(`displayField '${displayField}' is not in the field list`);
  }

  if (issues.length > 0) {
    throw new ValidationError("Content type definition is not valid", { issues, allowedTypes });
  }
  return {
    fields,
    ...(displayField ? { displayField } : {}),
    ...(shaped.data.ee ? { ee: shaped.data.ee } : {}),
  };
}
