/** Type definition → placeholder values (preview the JSON-LD shape without an entry, T9.1) */
import { FieldType } from "@prina/shared";
import type { ContentTypeDefinition, FieldDef } from "@prina/shared";

function sampleFor(
  field: FieldDef,
  componentDefs: Map<string, ContentTypeDefinition>,
): unknown {
  switch (field.type) {
    case FieldType.Text:
      return `Sample ${field.label ?? field.name}`;
    case FieldType.Uid:
      return "sample-slug";
    case FieldType.Richtext:
      return {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "Sample body text." }] }],
      };
    case FieldType.Number:
      return 42;
    case FieldType.Boolean:
      return true;
    case FieldType.Date:
      return "2026-01-01";
    case FieldType.Enum:
      return (field.options as string[] | undefined)?.[0] ?? "sample";
    case FieldType.Media: {
      const asset = {
        id: "00000000-0000-0000-0000-000000000000",
        url: "/delivery/assets/…",
        filename: "sample.jpg",
        mime: "image/jpeg",
        width: 1200,
        height: 800,
      };
      return (field as { multiple?: boolean }).multiple ? [asset] : asset;
    }
    case FieldType.Relation: {
      const node = {
        id: "00000000-0000-0000-0000-000000000000",
        display: `Sample ${(field as { target?: string }).target ?? "entry"}`,
        schemaOrgType: null,
      };
      const many =
        field.relationKind === "oneToMany" || field.relationKind === "manyToMany";
      return many ? [node] : node;
    }
    case FieldType.Component: {
      const def = componentDefs.get((field as { component: string }).component);
      const obj = Object.fromEntries(
        (def?.fields ?? [])
          .filter((f) => f.type === FieldType.Text || f.type === FieldType.Number)
          .map((f) => [f.name, sampleFor(f, componentDefs)]),
      );
      return (field as { repeatable?: boolean }).repeatable ? [obj] : obj;
    }
    case FieldType.DynamicZone: {
      const uid = (field.components as string[] | undefined)?.[0];
      const def = uid ? componentDefs.get(uid) : undefined;
      if (!uid || !def) return [];
      const obj = Object.fromEntries(
        def.fields
          .filter((f) => f.type === FieldType.Text || f.type === FieldType.Number)
          .map((f) => [f.name, sampleFor(f, componentDefs)]),
      );
      return [{ ...obj, __component: uid }];
    }
    default:
      return undefined;
  }
}

export function sampleValues(
  definition: ContentTypeDefinition,
  componentDefs: Map<string, ContentTypeDefinition>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of definition.fields) {
    const v = sampleFor(field, componentDefs);
    if (v !== undefined) out[field.name] = v;
  }
  return out;
}
