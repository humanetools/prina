/** Rich text tables (45-IMPL): schema, attribute validation, HTML serialization */
import { describe, expect, it } from "vitest";
import { validateRichtext, extractRichtextText } from "../src/content/richtext/index.js";
import { richtextToHtml } from "../src/content/richtext/html.js";

const p = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
const cell = (text: string, attrs: Record<string, unknown> = {}, type = "table_cell") => ({ type, attrs, content: [p(text)] });
const doc = (...rows: unknown[]) => ({ type: "doc", content: [{ type: "table", content: rows }] });
const row = (...cells: unknown[]) => ({ type: "table_row", content: cells });

describe("richtext — tables", () => {
  it("accepts a table with header cells, spans and hex colours", () => {
    const d = doc(
      row(cell("Spec", {}, "table_header"), cell("Value", { backgroundColor: "#f5f5f5" }, "table_header")),
      row(cell("Weight", { borderColor: "#FB6500" }), cell("12 kg")),
      row(cell("Merged", { colspan: 2, backgroundColor: "#fff" })),
    );
    expect(validateRichtext(d)).toEqual([]);
    expect(extractRichtextText(d)).toContain("Weight");
  });

  it("renders td/th with colspan, rowspan and inline colours only", () => {
    const html = richtextToHtml(doc(
      row(cell("H", {}, "table_header")),
      row(cell("A", { colspan: 2, rowspan: 2, backgroundColor: "#abc", borderColor: "#123456" })),
      row(cell("B")),
    ));
    expect(html).toBe(
      "<table><tbody>" +
        "<tr><th><p>H</p></th></tr>" +
        '<tr><td colspan="2" rowspan="2" style="background-color: #abc; border: 1px solid #123456"><p>A</p></td></tr>' +
        "<tr><td><p>B</p></td></tr>" +
      "</tbody></table>",
    );
  });

  it("rejects bad spans and non-hex colours — nothing else reaches a style attribute", () => {
    expect(validateRichtext(doc(row(cell("x", { colspan: 0 }))))).toEqual([expect.stringContaining("colspan must be an integer 1–50")]);
    expect(validateRichtext(doc(row(cell("x", { rowspan: 51 }))))).toEqual([expect.stringContaining("rowspan must be an integer 1–50")]);
    expect(validateRichtext(doc(row(cell("x", { backgroundColor: "red" }))))).toEqual([expect.stringContaining("backgroundColor must be a hex colour")]);
    expect(validateRichtext(doc(row(cell("x", { borderColor: "url(javascript:alert(1))" }))))).toEqual([expect.stringContaining("borderColor must be a hex colour")]);
    expect(validateRichtext(doc(row(cell("x", { colwidth: ["a"] }))))).toEqual([expect.stringContaining("colwidth")]);
    // a rejected colour is also never rendered (validation runs before save; html is defensive too)
    expect(richtextToHtml(doc(row(cell("x", { backgroundColor: "red" }))))).toBe("<table><tbody><tr><td><p>x</p></td></tr></tbody></table>");
  });

  it("structure is enforced by the schema: a table needs rows, a row needs cells, a cell needs a block", () => {
    expect(validateRichtext({ type: "doc", content: [{ type: "table", content: [] }] })).toEqual([expect.stringContaining("schema violation")]);
    expect(validateRichtext(doc({ type: "table_row", content: [p("loose")] }))).toEqual([expect.stringContaining("schema violation")]);
  });
});
