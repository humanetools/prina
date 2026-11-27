/**
 * Tiptap richtext (T3.4) — node/mark names kept in sync with the server ProseMirror schema.
 * The server (core) richtext/schema.ts uses snake_case names, so extension names match them.
 */
import { Extension } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import Document from "@tiptap/extension-document";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import Heading from "@tiptap/extension-heading";
import Blockquote from "@tiptap/extension-blockquote";
import CodeBlock from "@tiptap/extension-code-block";
import BulletList from "@tiptap/extension-bullet-list";
import OrderedList from "@tiptap/extension-ordered-list";
import ListItem from "@tiptap/extension-list-item";
import HardBreak from "@tiptap/extension-hard-break";
import HorizontalRule from "@tiptap/extension-horizontal-rule";
import Bold from "@tiptap/extension-bold";
import Italic from "@tiptap/extension-italic";
import Strike from "@tiptap/extension-strike";
import Code from "@tiptap/extension-code";
import Link from "@tiptap/extension-link";
import Image from "@tiptap/extension-image";
import History from "@tiptap/extension-history";
import Table from "@tiptap/extension-table";
import TableRow from "@tiptap/extension-table-row";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import {
  IconAlignCenter,
  IconAlignLeft,
  IconAlignRight,
  IconBlockquote,
  IconBold,
  IconCode,
  IconItalic,
  IconList,
  IconListNumbers,
  IconStrikethrough, IconTable, IconTablePlus, IconColumnInsertLeft, IconColumnInsertRight, IconRowInsertTop, IconRowInsertBottom, IconColumnRemove, IconRowRemove, IconTableOff, IconArrowsJoin, IconArrowsSplit, IconPaint, IconBorderOuter, IconX } from "@tabler/icons-react";
import type { WidgetProps } from "./BasicWidgets";

/** Same values the server accepts (core richtext/schema.ts, 30-IMPL). No alignment = follow the site's CSS */
const TEXT_ALIGNS = ["left", "center", "right"] as const;
type TextAlignValue = (typeof TEXT_ALIGNS)[number];
const HEADING_LEVELS = [1, 2, 3, 4, 5, 6] as const;
const ALIGNED_BLOCKS = ["paragraph", "heading"];

/** `textAlign` attribute on paragraphs and headings — the shape Tiptap's own TextAlign extension stores */
const TextAlign = Extension.create({
  name: "textAlign",
  addGlobalAttributes() {
    return [{
      types: ALIGNED_BLOCKS,
      attributes: {
        textAlign: {
          default: null,
          parseHTML: (el) => ((TEXT_ALIGNS as readonly string[]).includes(el.style.textAlign) ? el.style.textAlign : null),
          renderHTML: (attrs) => (attrs.textAlign ? { style: `text-align: ${attrs.textAlign as string}` } : {}),
        },
      },
    }];
  },
});

/** Table cells (45-IMPL): spans from prosemirror-tables plus two hex colours — the server validates the same shape */
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const cellColorAttrs = {
  backgroundColor: {
    default: null,
    parseHTML: (el: HTMLElement) => (HEX.test(el.style.backgroundColor) ? el.style.backgroundColor : null),
    renderHTML: (attrs: Record<string, unknown>) => (attrs.backgroundColor ? { style: `background-color: ${attrs.backgroundColor as string}` } : {}),
  },
  borderColor: {
    default: null,
    parseHTML: (el: HTMLElement) => (HEX.test(el.style.borderColor) ? el.style.borderColor : null),
    renderHTML: (attrs: Record<string, unknown>) => (attrs.borderColor ? { style: `border: 1px solid ${attrs.borderColor as string}` } : {}),
  },
};
const withCellColors = (Base: typeof TableCell, name: string) =>
  Base.extend({
    name,
    addAttributes() {
      return { ...(this.parent?.() ?? {}), ...cellColorAttrs };
    },
  });

const extensions = [
  Document,
  Paragraph,
  Text,
  History,
  Heading.configure({ levels: [...HEADING_LEVELS] }),
  TextAlign,
  Blockquote,
  CodeBlock.extend({ name: "code_block" }),
  BulletList.extend({ name: "bullet_list" }).configure({ itemTypeName: "list_item" }),
  OrderedList.extend({ name: "ordered_list" }).configure({ itemTypeName: "list_item" }),
  ListItem.extend({ name: "list_item" }),
  HardBreak.extend({ name: "hard_break" }),
  HorizontalRule.extend({ name: "horizontal_rule" }),
  Bold,
  Italic,
  Strike,
  Code,
  Link.configure({ openOnClick: false }),
  // Tables (45-IMPL) — node names match the core schema (table · table_row · table_cell · table_header);
  // prosemirror-tables finds them by tableRole, so the renames are safe
  Table.extend({ content: "table_row+" }).configure({ resizable: false, HTMLAttributes: { class: "rt-table" } }),
  TableRow.extend({ name: "table_row", content: "(table_cell | table_header)*" }),
  withCellColors(TableCell, "table_cell"),
  withCellColors(TableHeader as unknown as typeof TableCell, "table_header"),
  Image.extend({
    addAttributes() {
      return {
        src: { default: null },
        alt: { default: "" },
        assetId: { default: null },
      };
    },
  }),
];

const ALIGN_BUTTONS = [
  { value: "left", Icon: IconAlignLeft, title: "Align left" },
  { value: "center", Icon: IconAlignCenter, title: "Align center" },
  { value: "right", Icon: IconAlignRight, title: "Align right" },
] as const;

export function RichtextWidget({ value, onChange }: WidgetProps) {
  const editor = useEditor({
    extensions,
    content: (value as object) ?? null,
    onUpdate: ({ editor: e }) => {
      const json = e.getJSON();
      onChange(e.isEmpty ? null : json);
    },
  });

  if (!editor) return null;
  const btn = (active: boolean) => (active ? "rt-btn active" : "rt-btn");
  const blockValue = HEADING_LEVELS.find((l) => editor.isActive("heading", { level: l })) ?? 0;
  // clicking the active alignment clears it — the block goes back to the site's default
  const setAlign = (align: TextAlignValue) => {
    const next = editor.isActive({ textAlign: align }) ? null : align;
    let chain = editor.chain().focus();
    for (const type of ALIGNED_BLOCKS) chain = chain.updateAttributes(type, { textAlign: next });
    chain.run();
  };

  return (
    <div className="richtext">
      {/* buttons must not take focus from the editor — a key pressed right after a click would land on the button */}
      <div className="rt-toolbar" onMouseDown={(e) => { if (!(e.target instanceof HTMLSelectElement)) e.preventDefault(); }}>
        <button type="button" className={btn(editor.isActive("bold"))}
          onClick={() => editor.chain().focus().toggleBold().run()} title="Bold">
          <IconBold size="1.5rem" />
        </button>
        <button type="button" className={btn(editor.isActive("italic"))}
          onClick={() => editor.chain().focus().toggleItalic().run()} title="Italic">
          <IconItalic size="1.5rem" />
        </button>
        <button type="button" className={btn(editor.isActive("strike"))}
          onClick={() => editor.chain().focus().toggleStrike().run()} title="Strikethrough">
          <IconStrikethrough size="1.5rem" />
        </button>
        <button type="button" className={btn(editor.isActive("code"))}
          onClick={() => editor.chain().focus().toggleCode().run()} title="Code">
          <IconCode size="1.5rem" />
        </button>
        <span className="rt-sep" />
        {/* block kind — a select, six heading buttons would take the whole toolbar */}
        <select
          className="rt-block" aria-label="Block type" value={blockValue}
          onChange={(e) => {
            const level = Number(e.target.value);
            if (level === 0) editor.chain().focus().setParagraph().run();
            else editor.chain().focus().setHeading({ level: level as (typeof HEADING_LEVELS)[number] }).run();
          }}
        >
          <option value={0}>Paragraph</option>
          {HEADING_LEVELS.map((l) => <option key={l} value={l}>Heading {l}</option>)}
        </select>
        <span className="rt-sep" />
        {ALIGN_BUTTONS.map(({ value: align, Icon, title }) => (
          <button key={align} type="button" className={btn(editor.isActive({ textAlign: align }))} title={title} onClick={() => setAlign(align)}>
            <Icon size="1.5rem" />
          </button>
        ))}
        <span className="rt-sep" />
        <button type="button" className={btn(editor.isActive("bullet_list"))}
          onClick={() => editor.chain().focus().toggleBulletList().run()} title="Bullet list">
          <IconList size="1.5rem" />
        </button>
        <button type="button" className={btn(editor.isActive("ordered_list"))}
          onClick={() => editor.chain().focus().toggleOrderedList().run()} title="Numbered list">
          <IconListNumbers size="1.5rem" />
        </button>
        <button type="button" className={btn(editor.isActive("blockquote"))}
          onClick={() => editor.chain().focus().toggleBlockquote().run()} title="Quote">
          <IconBlockquote size="1.5rem" />
        </button>
        <span className="rt-sep" />
        <TableTools editor={editor} />
      </div>
      <EditorContent editor={editor} className="rt-content" />
    </div>
  );
}

/** Table toolbar (45-IMPL): insert, rows/columns, merge/split, header row, cell colours, delete */
function TableTools({ editor }: { editor: NonNullable<ReturnType<typeof useEditor>> }) {
  const inTable = editor.isActive("table");
  const btn = (active = false) => (active ? "rt-btn active" : "rt-btn");
  const cellAttr = (key: "backgroundColor" | "borderColor"): string => {
    const v = (editor.getAttributes("table_cell")[key] ?? editor.getAttributes("table_header")[key]) as string | null | undefined;
    return typeof v === "string" ? v : "";
  };
  const setCellColor = (key: "backgroundColor" | "borderColor", value: string | null) =>
    editor.chain().focus().setCellAttribute(key, value).run();
  if (!inTable) {
    return (
      <button type="button" className={btn()} title="Insert table (3 × 3, header row)"
        onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}>
        <IconTablePlus size="1.5rem" />
      </button>
    );
  }
  return (
    <>
      <span className="rt-table-tag" title="Cursor is inside a table"><IconTable size="1.3rem" /></span>
      <button type="button" className={btn()} title="Add column before" onClick={() => editor.chain().focus().addColumnBefore().run()}><IconColumnInsertLeft size="1.5rem" /></button>
      <button type="button" className={btn()} title="Add column after" onClick={() => editor.chain().focus().addColumnAfter().run()}><IconColumnInsertRight size="1.5rem" /></button>
      <button type="button" className={btn()} title="Delete column" onClick={() => editor.chain().focus().deleteColumn().run()}><IconColumnRemove size="1.5rem" /></button>
      <button type="button" className={btn()} title="Add row above" onClick={() => editor.chain().focus().addRowBefore().run()}><IconRowInsertTop size="1.5rem" /></button>
      <button type="button" className={btn()} title="Add row below" onClick={() => editor.chain().focus().addRowAfter().run()}><IconRowInsertBottom size="1.5rem" /></button>
      <button type="button" className={btn()} title="Delete row" onClick={() => editor.chain().focus().deleteRow().run()}><IconRowRemove size="1.5rem" /></button>
      <span className="rt-sep" />
      <button type="button" className={btn()} title="Merge selected cells (drag across cells to select)" disabled={!editor.can().mergeCells()}
        onClick={() => editor.chain().focus().mergeCells().run()}><IconArrowsJoin size="1.5rem" /></button>
      <button type="button" className={btn()} title="Split cell" disabled={!editor.can().splitCell()}
        onClick={() => editor.chain().focus().splitCell().run()}><IconArrowsSplit size="1.5rem" /></button>
      <button type="button" className={btn(editor.isActive("table_header"))} title="Toggle header row"
        onClick={() => editor.chain().focus().toggleHeaderRow().run()}>TH</button>
      <span className="rt-sep" />
      <label className="rt-color" title="Cell background colour">
        <IconPaint size="1.4rem" />
        <input type="color" value={cellAttr("backgroundColor") || "#ffffff"} onChange={(e) => setCellColor("backgroundColor", e.target.value)} />
        {cellAttr("backgroundColor") && (
          <button type="button" className="rt-color-clear" title="Clear background" onClick={() => setCellColor("backgroundColor", null)}><IconX size="1.1rem" /></button>
        )}
      </label>
      <label className="rt-color" title="Cell border colour">
        <IconBorderOuter size="1.4rem" />
        <input type="color" value={cellAttr("borderColor") || "#d4d4d4"} onChange={(e) => setCellColor("borderColor", e.target.value)} />
        {cellAttr("borderColor") && (
          <button type="button" className="rt-color-clear" title="Clear border colour" onClick={() => setCellColor("borderColor", null)}><IconX size="1.1rem" /></button>
        )}
      </label>
      <span className="rt-sep" />
      <button type="button" className="rt-btn danger" title="Delete table" onClick={() => editor.chain().focus().deleteTable().run()}><IconTableOff size="1.5rem" /></button>
    </>
  );
}
