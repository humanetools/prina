/** Add field picker groups/descriptions (design fieldGroups) — glyph/hue handled by FieldTypeTile */
import { FieldType } from "../../../api/types";

export const TYPE_LABEL: Record<string, string> = {
  [FieldType.Text]: "Text",
  [FieldType.Uid]: "UID",
  [FieldType.Richtext]: "Rich text",
  [FieldType.Number]: "Number",
  [FieldType.Boolean]: "Boolean",
  [FieldType.Date]: "Date",
  [FieldType.Enum]: "Enumeration",
  [FieldType.Json]: "JSON",
  [FieldType.Media]: "Media",
  [FieldType.Relation]: "Relation",
  [FieldType.Component]: "Component",
  [FieldType.DynamicZone]: "Dynamic zone",
  [FieldType.VariantAxis]: "Variant axis",
};

export interface FieldTypeItem {
  type: FieldType;
  desc: string;
}

export const FIELD_GROUPS: Array<{ label: string; items: FieldTypeItem[] }> = [
  {
    label: "Text",
    items: [
      { type: FieldType.Text, desc: "Short or long string, localizable" },
      { type: FieldType.Richtext, desc: "Tiptap editor with a minimal toolbar" },
      { type: FieldType.Uid, desc: "Unique slug or SKU, derived from a field" },
    ],
  },
  {
    label: "Number & time",
    items: [
      { type: FieldType.Number, desc: "Integer, decimal or float" },
      { type: FieldType.Date, desc: "Date, time or datetime" },
      { type: FieldType.Boolean, desc: "True / false toggle" },
      { type: FieldType.Enum, desc: "Fixed list of values" },
    ],
  },
  {
    label: "Relational",
    items: [
      { type: FieldType.Relation, desc: "Link to another type, with predicate" },
      { type: FieldType.Media, desc: "Single or multiple assets" },
      { type: FieldType.Component, desc: "Reusable field group" },
      { type: FieldType.DynamicZone, desc: "Editor picks from allowed components" },
    ],
  },
  {
    label: "Commerce & data",
    items: [
      { type: FieldType.VariantAxis, desc: "Generates child SKUs — color, size, edition" },
      { type: FieldType.Json, desc: "Raw structured payload" },
    ],
  },
];

/** Rule summary for the edit header subtitle (type · rule) */
export function fieldRuleSummary(def: Record<string, unknown>): string {
  const parts: string[] = [];
  if (def.required) parts.push("required");
  if (def.localized) parts.push("localized");
  if (def.unique || def.type === FieldType.Uid) parts.push("unique");
  if (def.type === FieldType.Uid && def.targetField) parts.push(`from ${def.targetField}`);
  if (def.type === FieldType.Media && def.multiple) parts.push(`min ${def.min ?? 1}`);
  if (def.type === FieldType.Relation && def.target) parts.push(`→ ${def.target}`);
  return parts.length ? parts.join(" · ") : "optional";
}
