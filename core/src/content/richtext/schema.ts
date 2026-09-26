/**
 * ProseMirror doc schema (T1.8) — single definition of the storage format.
 * Admin's Tiptap editor is configured to be compatible with this schema (node/mark names in sync).
 * core is headless and uses only prosemirror-model — input via MCP must also pass this schema.
 */
import { Schema, type Node as PmNode } from "prosemirror-model";

/** Paragraph / heading alignment (30-IMPL). Absent (null) = follow the site's CSS — alignment marks an exception */
export const TEXT_ALIGNS = ["left", "center", "right"] as const;
export const HEADING_LEVELS = [1, 2, 3, 4, 5, 6] as const;

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
