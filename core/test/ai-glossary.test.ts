/** Translation glossary (37-IMPL-translation-glossary) — grid save, pair selection, prompt, Excel */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { contentTypeCreate } from "../src/modules/content-type/commands.js";
import { entryCreate } from "../src/modules/entry/commands.js";
import { localeCreate } from "../src/modules/locale/commands.js";
import { entryAiTranslate } from "../src/modules/ai/translate-commands.js";
import {
  aiGlossaryExport,
  aiGlossaryGet,
  aiGlossaryParse,
  aiGlossarySet,
} from "../src/modules/ai/glossary-commands.js";
import {
  glossaryPairs,
  glossaryPromptBlock,
  resolveHeaderLocale,
  xlsxToGlossary,
} from "../src/modules/ai/glossary.js";
import { ForbiddenError } from "../src/lib/errors.js";
import { setupTestContext, type TestContext } from "./helpers.js";

let t: TestContext;

beforeAll(async () => {
  t = await setupTestContext();
  await localeCreate.run({ code: "en", name: "English" }, t.ctx);
  await localeCreate.run({ code: "ja", name: "Japanese" }, t.ctx);
  await contentTypeCreate.run(
    {
      uid: "note",
      name: "Note",
      definition: {
        displayField: "title",
        fields: [
          { name: "title", type: "text", label: "Title" },
          { name: "body", type: "text", label: "Body" },
        ],
      },
    },
    t.ctx,
  );
});
afterAll(() => t.cleanup());

describe("glossary grid", () => {
  it("saves rows in order, trims cells, drops empty rows and unknown locales", async () => {
    const out = await aiGlossarySet.run(
      {
        rows: [
          { terms: { ko: " 프리나 ", en: "Prina", fr: "ignored" } },
          { terms: { ko: "", en: "   " } },
          { terms: { ko: "콘텐츠 허브", en: "Content Hub", ja: "コンテンツハブ" } },
        ],
      },
      t.ctx,
    );
    expect(out.rows.map((r) => r.terms)).toEqual([
      { ko: "프리나", en: "Prina" },
      { ko: "콘텐츠 허브", en: "Content Hub", ja: "コンテンツハブ" },
    ]);

    const got = await aiGlossaryGet.run({}, t.ctx);
    // default locale first, then the rest by code
    expect(got.locales.map((l) => l.code)).toEqual(["ko", "en", "ja"]);
    expect(got.rows).toHaveLength(2);

    // re-save keeps an existing id, reorders, and drops what is missing
    const [first, second] = got.rows;
    const again = await aiGlossarySet.run(
      { rows: [{ id: second!.id, terms: second!.terms }, { terms: { ko: "새 용어", en: "New term" } }] },
      t.ctx,
    );
    expect(again.rows[0]!.id).toBe(second!.id);
    expect(again.rows.map((r) => r.id)).not.toContain(first!.id);
    expect(again.rows).toHaveLength(2);
  });

  it("needs the settings permission", async () => {
    const { ctx } = await t.createUserCtx(["editor"]);
    await expect(aiGlossarySet.run({ rows: [] }, ctx)).rejects.toThrow(ForbiddenError);
  });
});

describe("pair selection and prompt", () => {
  const rows: Array<{ terms: Record<string, string> }> = [
    { terms: { ko: "프리나", en: "Prina" } },
    { terms: { ko: "콘텐츠 허브", en: "Content Hub" } },
    { terms: { ko: "허브", en: "Hub" } },
    { terms: { ko: "미등장", en: "Absent" } },
    { terms: { ko: "영어없음" } },
  ];

  it("keeps only pairs present in the text, longest source first", () => {
    const pairs = glossaryPairs(rows, "ko", "en", ["프리나는 콘텐츠 허브다", "두 번째 세그먼트"]);
    expect(pairs).toEqual([
      { source: "콘텐츠 허브", target: "Content Hub" },
      { source: "프리나", target: "Prina" },
      { source: "허브", target: "Hub" },
    ]);
    expect(glossaryPairs(rows, "ko", "ko", ["프리나"])).toEqual([]);
    expect(glossaryPairs(rows, "ko", "en", ["아무 용어도 없음"])).toEqual([]);
  });

  it("matches case-insensitively and renders a rule block", () => {
    const pairs = glossaryPairs([{ terms: { en: "Content Hub", ko: "콘텐츠 허브" } }], "en", "ko", ["the CONTENT hub"]);
    expect(pairs).toHaveLength(1);
    const block = glossaryPromptBlock(pairs);
    expect(block).toContain('"Content Hub" → "콘텐츠 허브"');
    expect(glossaryPromptBlock([])).toBe("");
  });

  it("entry.ai_translate hands the applicable pairs to the model", async () => {
    await aiGlossarySet.run(
      { rows: [{ terms: { ko: "프리나", en: "Prina" } }, { terms: { ko: "미등장", en: "Absent" } }] },
      t.ctx,
    );
    let seenSystem = "";
    t.services.llm = async ({ system, user }) => {
      seenSystem = system;
      const segments = JSON.parse(user) as Record<string, string>;
      return JSON.stringify(Object.fromEntries(Object.keys(segments).map((k) => [k, "Prina rocks"])));
    };
    const source = await entryCreate.run(
      { typeUid: "note", values: { title: "프리나 소개", body: "본문" } },
      t.ctx,
    );
    const out = await entryAiTranslate.run(
      { typeUid: "note", sourceEntryId: source.entry.id, targetLocale: "en" },
      t.ctx,
    );
    expect(out.glossaryApplied).toBe(1);
    expect(seenSystem).toContain("GLOSSARY");
    expect(seenSystem).toContain('"프리나" → "Prina"');
    expect(seenSystem).not.toContain("Absent");
    t.services.llm = undefined;
  });
});

describe("Excel", () => {
  it("exports the grid with locale codes as the header and reads it back", async () => {
    await aiGlossarySet.run(
      { rows: [{ terms: { ko: "프리나", en: "Prina", ja: "プリナ" } }, { terms: { ko: "허브", en: "Hub" } }] },
      t.ctx,
    );
    const file = await aiGlossaryExport.run({}, t.ctx);
    expect(file.filename).toMatch(/\.xlsx$/);
    const wb = XLSX.read(Buffer.from(file.dataBase64, "base64"), { type: "buffer" });
    const aoa = XLSX.utils.sheet_to_json<string[]>(wb.Sheets[wb.SheetNames[0]!]!, { header: 1 });
    expect(aoa[0]).toEqual(["ko", "en", "ja"]);
    expect(aoa[1]).toEqual(["프리나", "Prina", "プリナ"]);

    const parsed = await aiGlossaryParse.run({ filename: "g.xlsx", dataBase64: file.dataBase64 }, t.ctx);
    expect(parsed.columns).toEqual(["ko", "en", "ja"]);
    expect(parsed.rows.map((r) => r.terms)).toEqual([
      { ko: "프리나", en: "Prina", ja: "プリナ" },
      { ko: "허브", en: "Hub" },
    ]);
  });

  it("accepts locale names or 'Name (code)' headers and reports unknown columns", () => {
    const locs = [{ code: "ko", name: "Korean" }, { code: "en", name: "English" }];
    expect(resolveHeaderLocale("English", locs)).toBe("en");
    expect(resolveHeaderLocale("Korean (ko)", locs)).toBe("ko");
    expect(resolveHeaderLocale("EN", locs)).toBe("en");
    expect(resolveHeaderLocale("Note", locs)).toBeNull();

    const ws = XLSX.utils.aoa_to_sheet([["Korean", "English (en)", "Memo"], ["허브", "Hub", "x"], ["", "", "only memo"]]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "S");
    const parsed = xlsxToGlossary(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer, locs);
    expect(parsed.columns).toEqual(["ko", "en"]);
    expect(parsed.ignoredColumns).toEqual(["Memo"]);
    expect(parsed.rows).toEqual([{ terms: { ko: "허브", en: "Hub" } }]);
  });

  it("rejects a sheet with no locale column", async () => {
    const ws = XLSX.utils.aoa_to_sheet([["Term", "Translation"], ["a", "b"]]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "S");
    const b64 = (XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer).toString("base64");
    await expect(aiGlossaryParse.run({ filename: "x.xlsx", dataBase64: b64 }, t.ctx)).rejects.toThrow(/No column matches/);
  });
});
