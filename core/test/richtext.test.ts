/** Richtext schema (T1.8 + 30-IMPL): heading levels 1–6 and paragraph / heading alignment */
import { describe, expect, it } from "vitest";
import { Node } from "prosemirror-model";
import { validateRichtext, extractRichtextText } from "../src/content/richtext/index.js";
import { richtextSchema } from "../src/content/richtext/schema.js";

const text = (t: string) => [{ type: "text", text: t }];
const doc = (...content: unknown[]) => ({ type: "doc", content });

describe("richtext — heading levels", () => {
  it("accepts levels 1–6 and the default when the attribute is absent", () => {
    for (const level of [1, 2, 3, 4, 5, 6]) {
      expect(validateRichtext(doc({ type: "heading", attrs: { level }, content: text(`h${level}`) })), `level ${level}`).toEqual([]);
    }
    expect(validateRichtext(doc({ type: "heading", content: text("default") }))).toEqual([]);
  });

  it("rejects anything else — it used to be stored as is", () => {
    for (const level of [0, 7, 2.5, "2", "1><script>", null]) {
      const issues = validateRichtext(doc({ type: "heading", attrs: { level }, content: text("x") }));
      expect(issues.join(" "), JSON.stringify(level)).toContain("heading level must be an integer 1–6");
    }
  });
});

describe("richtext — text alignment", () => {
  it("accepts left / center / right / null on paragraphs and headings, also inside lists and quotes", () => {
    const value = doc(
      { type: "paragraph", attrs: { textAlign: "center" }, content: text("centered") },
      { type: "paragraph", attrs: { textAlign: null }, content: text("site default") },
      { type: "heading", attrs: { level: 3, textAlign: "right" }, content: text("right heading") },
      { type: "blockquote", content: [{ type: "paragraph", attrs: { textAlign: "left" }, content: text("quoted") }] },
      { type: "bullet_list", content: [{ type: "list_item", content: [{ type: "paragraph", attrs: { textAlign: "center" }, content: text("item") }] }] },
    );
    expect(validateRichtext(value)).toEqual([]);
    expect(extractRichtextText(value)).toContain("centered");
  });

  it("rejects justify and free-form values", () => {
    for (const textAlign of ["justify", "CENTER", "center; color: red", 1]) {
      const issues = validateRichtext(doc({ type: "paragraph", attrs: { textAlign }, content: text("x") }));
      expect(issues.join(" "), JSON.stringify(textAlign)).toContain("textAlign must be one of left, center, right or null");
    }
  });

  it("documents written before the attribute existed stay valid", () => {
    expect(validateRichtext(doc({ type: "paragraph", content: text("old") }, { type: "heading", attrs: { level: 2 }, content: text("old heading") }))).toEqual([]);
  });
});

describe("richtext — toDOM mirrors the rule", () => {
  it("emits the heading tag for the level and a text-align style only for a known alignment", () => {
    const spec = (json: unknown) => {
      const node = Node.fromJSON(richtextSchema, json);
      return node.type.spec.toDOM!(node) as unknown[];
    };
    expect(spec({ type: "heading", attrs: { level: 5, textAlign: "center" }, content: text("x") })).toEqual(["h5", { style: "text-align: center" }, 0]);
    expect(spec({ type: "paragraph", content: text("x") })).toEqual(["p", {}, 0]);
    // an unchecked level never becomes part of a tag name
    expect(spec({ type: "heading", attrs: { level: "1><script>" }, content: text("x") })[0]).toBe("h2");
  });
});
