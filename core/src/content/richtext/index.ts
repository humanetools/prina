/** Server-side richtext validation and text extraction (T1.8) */
import { Node } from "prosemirror-model";
import { CELL_COLOR_RE, CELL_MAX_SPAN, HEADING_LEVELS, TEXT_ALIGNS, richtextSchema } from "./schema.js";

/** Pre-save validation — returns error messages on schema violation (essential for input via MCP) */
export function validateRichtext(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value !== "object" || Array.isArray(value)) {
    return ["A richtext value must be a ProseMirror doc JSON object"];
  }
  try {
    const doc = Node.fromJSON(richtextSchema, value);
    doc.check();
    if (doc.type.name !== "doc") return ["The root node must be a doc"];
    // ProseMirror checks structure, not attribute values — a heading level or an alignment is free-form to it
    const issues: string[] = [];
    doc.descendants((node) => {
      if (node.type.name === "heading" && !(HEADING_LEVELS as readonly unknown[]).includes(node.attrs.level)) {
        issues.push(`Richtext heading level must be an integer 1–6 (got ${JSON.stringify(node.attrs.level)})`);
      }
      const align: unknown = node.attrs.textAlign;
      if (align !== undefined && align !== null && !(TEXT_ALIGNS as readonly unknown[]).includes(align)) {
        issues.push(`Richtext textAlign must be one of ${TEXT_ALIGNS.join(", ")} or null (got ${JSON.stringify(align)})`);
      }
      if (node.type.name === "table_cell" || node.type.name === "table_header") {
        for (const key of ["colspan", "rowspan"] as const) {
          const v: unknown = node.attrs[key];
          if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > CELL_MAX_SPAN) {
            issues.push(`Richtext table ${key} must be an integer 1–${CELL_MAX_SPAN} (got ${JSON.stringify(v)})`);
          }
        }
        const cw: unknown = node.attrs.colwidth;
        if (cw !== null && cw !== undefined && !(Array.isArray(cw) && cw.every((w) => Number.isInteger(w) && (w as number) > 0))) {
          issues.push(`Richtext table colwidth must be null or a list of positive integers`);
        }
        for (const key of ["backgroundColor", "borderColor"] as const) {
          const v: unknown = node.attrs[key];
          if (v !== null && v !== undefined && !(typeof v === "string" && CELL_COLOR_RE.test(v))) {
            issues.push(`Richtext table ${key} must be a hex colour like #1a2b3c or null (got ${JSON.stringify(v)})`);
          }
        }
      }
      return true;
    });
    return issues;
  } catch (e) {
    return [`Richtext schema violation: ${e instanceof Error ? e.message : String(e)}`];
  }
}

/** Plain-text extraction for search indexing */
export function extractRichtextText(value: unknown): string {
  if (value === null || value === undefined) return "";
  try {
    const doc = Node.fromJSON(richtextSchema, value);
    return doc.textBetween(0, doc.content.size, "\n", " ").trim();
  } catch {
    return "";
  }
}

/** Collect DAM asset references in the body — used by usage tracking (T4.3) */
export function extractRichtextAssetIds(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  const ids: string[] = [];
  try {
    const doc = Node.fromJSON(richtextSchema, value);
    doc.descendants((node) => {
      if (node.type.name === "image" && typeof node.attrs.assetId === "string") {
        ids.push(node.attrs.assetId);
      }
      return true;
    });
  } catch {
    /* Filtered out at the validation stage */
  }
  return ids;
}
