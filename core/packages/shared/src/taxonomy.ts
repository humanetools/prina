/**
 * Taxonomy attributes (33-IMPL) — information about a classification node itself (a description, a code,
 * a display flag), as opposed to the entry component a node exposes to the entries under it.
 * Fields are defined per taxonomy; every node of that taxonomy carries values for them.
 */
export enum TaxonomyAttributeType {
  Text = "text",
  Number = "number",
  Boolean = "boolean",
}

export interface TaxonomyAttributeField {
  /** key in node.attributes — snake_case */
  name: string;
  label?: string;
  type: TaxonomyAttributeType;
  /** text only — multi-line editor */
  multiline?: boolean;
}
