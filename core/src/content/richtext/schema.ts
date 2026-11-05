/**
 * ProseMirror doc schema (T1.8) — single definition of the storage format.
 * Admin's Tiptap editor is configured to be compatible with this schema (node/mark names in sync).
 * core is headless and uses only prosemirror-model — input via MCP must also pass this schema.
 */
import { Schema, type Node as PmNode } from "prosemirror-model";

/** Paragraph / heading alignment (30-IMPL). Absent (null) = follow the site's CSS — alignment marks an exception */
export const TEXT_ALIGNS = ["left", "center", "right"] as const;
export const HEADING_LEVELS = [1, 2, 3, 4, 5, 6] as const;

/** Table cells (45-IMPL): spans are capped, colours are hex only — nothing else reaches a style attribute */
export const CELL_MAX_SPAN = 50;
export const CELL_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const cellStyle = (node: PmNode): Record<string, string | number> => {
  const attrs: Record<string, string | number> = {};
  const colspan = node.attrs.colspan as number;
  const rowspan = node.attrs.rowspan as number;
  if (Number.isInteger(colspan) && colspan > 1) attrs.colspan = colspan;
  if (Number.isInteger(rowspan) && rowspan > 1) attrs.rowspan = rowspan;
  const styles: string[] = [];
  if (CELL_COLOR_RE.test(String(node.attrs.backgroundColor ?? ""))) styles.push(`background-color: ${node.attrs.backgroundColor}`);
  if (CELL_COLOR_RE.test(String(node.attrs.borderColor ?? ""))) styles.push(`border: 1px solid ${node.attrs.borderColor}`);
  if (styles.length) attrs.style = styles.join("; ");
  return attrs;
};
const CELL_ATTRS = {
  colspan: { default: 1 },
  rowspan: { default: 1 },
  /** prosemirror-tables column widths (resizing) — stored for round-trips, not rendered */
  colwidth: { default: null },
  backgroundColor: { default: null },
  borderColor: { default: null },
};

/** `style` for an aligned block — the attribute has been validated, so nothing else can reach the markup */
const alignStyle = (node: PmNode): Record<string, string> =>
  (TEXT_ALIGNS as readonly string[]).includes(node.attrs.textAlign as string) ? { style: `text-align: ${node.attrs.textAlign}` } : {};

export const richtextSchema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      group: "block",
      content: "inline*",
      attrs: { textAlign: { default: null } },
      parseDOM: [{ tag: "p" }],
      toDOM: (node) => ["p", alignStyle(node), 0],
    },
    heading: {
      group: "block",
      content: "inline*",
      attrs: { level: { default: 2 }, textAlign: { default: null } },
      // level is checked by validateRichtext (1–6) — never interpolate an unchecked value into a tag name
      toDOM: (node) => [`h${(HEADING_LEVELS as readonly number[]).includes(node.attrs.level as number) ? node.attrs.level : 2}`, alignStyle(node), 0],
    },
    blockquote: {
      group: "block",
      content: "block+",
      toDOM: () => ["blockquote", 0],
    },
    code_block: {
      group: "block",
      content: "text*",
      marks: "",
      attrs: { language: { default: null } },
      toDOM: () => ["pre", ["code", 0]],
    },
    bullet_list: {
      group: "block",
      content: "list_item+",
      toDOM: () => ["ul", 0],
    },
    ordered_list: {
      group: "block",
      content: "list_item+",
      attrs: { start: { default: 1 } },
      toDOM: () => ["ol", 0],
    },
    list_item: {
      content: "paragraph block*",
      toDOM: () => ["li", 0],
    },
    image: {
      group: "block",
      attrs: {
        /** DAM asset reference — scan target for usage tracking (T4.3) */
        assetId: { default: null },
        src: { default: null },
        alt: { default: "" },
      },
      toDOM: (node) => ["img", { src: node.attrs.src, alt: node.attrs.alt }],
    },
    horizontal_rule: { group: "block", toDOM: () => ["hr"] },
    // Tables (45-IMPL) — same node names / roles as Tiptap's Table extensions (admin renames tableRow → table_row etc.)
    table: {
      group: "block",
      content: "table_row+",
      tableRole: "table",
      isolating: true,
      toDOM: () => ["table", ["tbody", 0]],
    },
    table_row: {
      content: "(table_cell | table_header)*",
      tableRole: "row",
      toDOM: () => ["tr", 0],
    },
    table_cell: {
      content: "block+",
      attrs: CELL_ATTRS,
      tableRole: "cell",
      isolating: true,
      toDOM: (node) => ["td", cellStyle(node), 0],
    },
    table_header: {
      content: "block+",
      attrs: CELL_ATTRS,
      tableRole: "header_cell",
      isolating: true,
      toDOM: (node) => ["th", cellStyle(node), 0],
    },
    hard_break: { group: "inline", inline: true, toDOM: () => ["br"] },
    text: { group: "inline" },
  },
  marks: {
    bold: { toDOM: () => ["strong", 0] },
    italic: { toDOM: () => ["em", 0] },
    code: { toDOM: () => ["code", 0] },
    strike: { toDOM: () => ["s", 0] },
    link: {
      attrs: { href: {}, title: { default: null } },
      inclusive: false,
      toDOM: (mark) => ["a", { href: mark.attrs.href }, 0],
    },
  },
});
