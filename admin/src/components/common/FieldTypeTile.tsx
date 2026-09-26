/**
 * Field type tile (design rule: "hue rotates, chroma and lightness do not")
 * Only hue varies per type; chroma/lightness stay fixed — the list never turns gaudy.
 */
import { FieldType } from "../../api/types";

/** Type → hue (tiles map from the design token doc) */
const HUE: Record<string, number> = {
  [FieldType.Text]: 258,
  [FieldType.Uid]: 288,
  [FieldType.Richtext]: 232,
  [FieldType.Number]: 152,
  [FieldType.Boolean]: 200,
  [FieldType.Date]: 96,
  [FieldType.Enum]: 320,
  [FieldType.Json]: 250,
  [FieldType.Media]: 296,
  [FieldType.Relation]: 258,
  [FieldType.Component]: 210,
  [FieldType.DynamicZone]: 210,
  [FieldType.VariantAxis]: 340,
};

/** Type → glyph */
const GLYPH: Record<string, string> = {
  [FieldType.Text]: "Aa",
  [FieldType.Uid]: "#",
  [FieldType.Richtext]: "¶",
  [FieldType.Number]: "12",
  [FieldType.Boolean]: "◑",
  [FieldType.Date]: "◷",
  [FieldType.Enum]: "≡",
  [FieldType.Json]: "{ }",
  [FieldType.Media]: "◨",
  [FieldType.Relation]: "⇄",
  [FieldType.Component]: "▤",
  [FieldType.DynamicZone]: "∞",
  [FieldType.VariantAxis]: "⋔",
};

/** Only hue is passed as a CSS variable; lightness/chroma are decided per theme by CSS (reacts instantly to theme switch) */
export function fieldTileStyle(type: string): React.CSSProperties {
  return { "--tile-hue": HUE[type] ?? 264 } as React.CSSProperties;
}

export function FieldTypeTile({ type }: { type: string }) {
  return (
    <span className="ft-tile" style={fieldTileStyle(type)} title={type}>
      {GLYPH[type] ?? "?"}
    </span>
  );
}
