/** Server-side richtext validation and text extraction (T1.8) */
import { Node } from "prosemirror-model";
import { richtextSchema } from "./schema.js";

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
    return [];
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
