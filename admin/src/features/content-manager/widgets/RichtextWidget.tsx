/**
 * Tiptap richtext (T3.4) — node/mark names kept in sync with the server ProseMirror schema.
 * The server (core) richtext/schema.ts uses snake_case names, so extension names match them.
 */
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
import {
  IconBlockquote,
  IconBold,
  IconCode,
  IconH2,
  IconItalic,
  IconList,
  IconListNumbers,
  IconStrikethrough,
} from "@tabler/icons-react";
import type { WidgetProps } from "./BasicWidgets";

const extensions = [
  Document,
  Paragraph,
  Text,
  History,
  Heading.configure({ levels: [1, 2, 3, 4] }),
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

  return (
    <div className="richtext">
      <div className="rt-toolbar">
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
        <button type="button" className={btn(editor.isActive("heading", { level: 2 }))}
          onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} title="Heading">
          <IconH2 size="1.5rem" />
        </button>
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
      </div>
      <EditorContent editor={editor} className="rt-content" />
    </div>
  );
}
