import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contentTypeCreate } from "../src/modules/content-type/commands.js";
import { entryCreate, entryGet, entryUpdate } from "../src/modules/entry/commands.js";
import { localeCreate } from "../src/modules/locale/commands.js";
import { ValidationError } from "../src/lib/errors.js";
import { setupTestContext, type TestContext } from "./helpers.js";
import { articleDefinition, productDefinition, validRichtextDoc } from "./fixtures.js";

let t: TestContext;
beforeAll(async () => {
  t = await setupTestContext();
  await contentTypeCreate.run(
    { uid: "article", name: "아티클", definition: articleDefinition },
    t.ctx,
  );
  await contentTypeCreate.run(
    { uid: "product", name: "상품", definition: productDefinition },
    t.ctx,
  );
});
afterAll(async () => t.cleanup());

describe("entry save/validation (T1.3~T1.5, T1.7, T1.8)", () => {
  it("CRUD for a type works with schema validation immediately after type creation (T1.3 DoD)", async () => {
    const saved = await entryCreate.run(
      { typeUid: "article", values: { title: "첫 글", body: validRichtextDoc } },
      t.ctx,
    );
    expect(saved.entry.locale).toBe("ko");
    expect(saved.entry.status).toBe("draft");
    expect(saved.version).toBe(1);
    // richtext text extraction → search indexing (T1.8)
    expect(saved.entry.searchText).toContain("첫 글");
    expect(saved.entry.searchText).toContain("Prina 본문");
  });

  it("wrongly-typed value returns 422", async () => {
    await expect(
      entryCreate.run(
        { typeUid: "article", values: { title: 123 } },
        t.ctx,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("field not in the definition returns 422 (additionalProperties: false)", async () => {
    await expect(
      entryCreate.run(
        { typeUid: "article", values: { hacker: "yes" } },
        t.ctx,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("schema-violating richtext returns 422 (guards input via MCP, T1.8)", async () => {
    await expect(
      entryCreate.run(
        {
          typeUid: "article",
          values: { title: "x", body: { type: "doc", content: [{ type: "evil" }] } },
        },
        t.ctx,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("completeness score and missing items — '2 more images needed' (T1.7 DoD)", async () => {
    const saved = await entryCreate.run(
      { typeUid: "product", values: { title: "카메라", price: 1000 } },
      t.ctx,
    );
    const detail = await entryGet.run(
      { typeUid: "product", id: saved.entry.id },
      t.ctx,
    );
    expect(detail.completeness.score).toBeLessThan(100);
    const imageMissing = detail.completeness.missing.find((m) => m.field === "images");
    expect(imageMissing?.reason).toBe("2 more image(s) needed");
  });

  it("i18n: adds an entry in another locale to the same documentId (T2.4 basis)", async () => {
    await localeCreate.run({ code: "en", name: "English" }, t.ctx);
    const ko = await entryCreate.run(
      { typeUid: "article", values: { title: "한국어" } },
      t.ctx,
    );
    const en = await entryCreate.run(
      {
        typeUid: "article",
        values: { title: "English" },
        locale: "en",
        documentId: ko.entry.documentId,
      },
      t.ctx,
    );
    expect(en.entry.documentId).toBe(ko.entry.documentId);
    // Duplicate in the same locale returns 409
    await expect(
      entryCreate.run(
        { typeUid: "article", values: {}, locale: "en", documentId: ko.entry.documentId },
        t.ctx,
      ),
    ).rejects.toThrow();
  });
});

describe("entry.list search (management list — full-list text search)", () => {
  it("finds entries on any page via search_text, richtext included", async () => {
    const { entryList } = await import("../src/modules/entry/commands.js");
    await entryCreate.run(
      { typeUid: "article", values: { title: "심해 탐사선 리뷰", body: validRichtextDoc } },
      t.ctx,
    );
    const byTitle = await entryList.run({ typeUid: "article", search: "심해 탐사선" }, t.ctx);
    expect(byTitle.items).toHaveLength(1);
    // richtext body text is part of search_text too
    const byBody = await entryList.run({ typeUid: "article", search: "Prina 본문" }, t.ctx);
    expect(byBody.items.length).toBeGreaterThanOrEqual(1);
    const none = await entryList.run({ typeUid: "article", search: "존재하지않는문구zzz" }, t.ctx);
    expect(none.items).toHaveLength(0);
    expect(none.pagination.total).toBe(0);
  });
});
