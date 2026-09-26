/** Server-side richtext validation and text extraction (T1.8) */
import { Node } from "prosemirror-model";
import { HEADING_LEVELS, TEXT_ALIGNS, richtextSchema } from "./schema.js";

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
