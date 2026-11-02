/** Type definition → placeholder values (preview the JSON-LD shape without an entry, T9.1) */
import { FieldType } from "@prina/shared";
import type { ContentTypeDefinition, FieldDef } from "@prina/shared";

const MAX_SAMPLE_DEPTH = 4;

function sampleFor(
  field: FieldDef,
  componentDefs: Map<string, ContentTypeDefinition>,
  depth = 0,
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
    // Components recurse (41-IMPL) so nested JSON-LD nodes show up in the sample snippet
    case FieldType.Component: {
      const def = componentDefs.get((field as { component: string }).component);
      if (!def || depth >= MAX_SAMPLE_DEPTH) return undefined;
      const obj = sampleValues(def, componentDefs, depth + 1);
      return (field as { repeatable?: boolean }).repeatable ? [obj] : obj;
    }
    case FieldType.DynamicZone: {
      if (depth >= MAX_SAMPLE_DEPTH) return [];
      // one block per allowed component — every mapped node type appears once
      return ((field.components as string[] | undefined) ?? [])
        .map((uid) => {
          const def = componentDefs.get(uid);
          return def ? { ...sampleValues(def, componentDefs, depth + 1), __component: uid } : null;
        })
        .filter((b) => b !== null) as Array<Record<string, unknown>>;
    }
    default:
      return undefined;
  }
}

export function sampleValues(
  definition: ContentTypeDefinition,
  componentDefs: Map<string, ContentTypeDefinition>,
  depth = 0,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of definition.fields) {
    const v = sampleFor(field, componentDefs, depth);
    if (v !== undefined) out[field.name] = v;
  }
  return out;
}
