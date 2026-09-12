/**
 * ProseMirror doc schema (T1.8) — single definition of the storage format.
 * Admin's Tiptap editor is configured to be compatible with this schema (node/mark names in sync).
 * core is headless and uses only prosemirror-model — input via MCP must also pass this schema.
 */
import { Schema } from "prosemirror-model";

export const richtextSchema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      group: "block",
      content: "inline*",
      parseDOM: [{ tag: "p" }],
      toDOM: () => ["p", 0],
    },
    heading: {
      group: "block",
      content: "inline*",
      attrs: { level: { default: 2 } },
      toDOM: (node) => [`h${node.attrs.level}`, 0],
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
