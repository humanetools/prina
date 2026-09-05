/** AI locale translation (IMPL-ai-locale-translation) — draft sibling creation, review semantics */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contentTypeCreate } from "../src/modules/content-type/commands.js";
import { componentCreate } from "../src/modules/content-type/component-commands.js";
import { entryCreate, entryGet, entryUpdate } from "../src/modules/entry/commands.js";
import { entrySetSeo } from "../src/modules/entry/seo.js";
import { entrySetTaxonomies } from "../src/modules/entry/document-commands.js";
import { taxonomyCreate, taxonomyNodeCreate } from "../src/modules/taxonomy/commands.js";
import { localeCreate } from "../src/modules/locale/commands.js";
import { entryAiTranslate } from "../src/modules/ai/translate-commands.js";
import { applySegments, collectSegments } from "../src/modules/ai/translate.js";
import { ConflictError } from "../src/lib/errors.js";
import { publishEntry, setupTestContext, type TestContext } from "./helpers.js";
import { articleDefinition, validRichtextDoc } from "./fixtures.js";

let t: TestContext;

/** LLM stub: echoes every segment back with an [en] prefix so assertions can spot it */
const stubLlm = () => {
  t.services.llm = async ({ user }) => {
    const segments = JSON.parse(user) as Record<string, string>;
    return JSON.stringify(
      Object.fromEntries(Object.entries(segments).map(([k, v]) => [k, `[en] ${v}`])),
    );
  };
};

beforeAll(async () => {
  t = await setupTestContext();
  await localeCreate.run({ code: "en", name: "English" }, t.ctx);
  await contentTypeCreate.run(
    { uid: "article", name: "Article", definition: articleDefinition },
    t.ctx,
  );
  // Localized-flag selection (decision ②): once any field is flagged, only flagged fields translate
  await componentCreate.run(
    {
      uid: "seo_box",
      name: "SEO box",
      definition: {
        fields: [
          { name: "meta_title", type: "text", label: "Meta title" },
          { name: "keywords", type: "text", label: "Keywords" },
        ],
      },
    },
    t.ctx,
  );
  await contentTypeCreate.run(
    {
      uid: "page",
      name: "Page",
      definition: {
        displayField: "title",
        fields: [
          { name: "title", type: "text", label: "Title" },
          { name: "excerpt", type: "text", label: "Excerpt", maxLength: 40 },
          { name: "seo", type: "component", label: "SEO", component: "seo_box" },
          {
            name: "blocks",
            type: "dynamic_zone",
            label: "Blocks",
            components: ["seo_box"],
          },
        ],
      },
    },
    t.ctx,
  );
  await contentTypeCreate.run(
    {
      uid: "notice",
      name: "Notice",
      definition: {
        displayField: "headline",
        fields: [
          { name: "headline", type: "text", label: "Headline", localized: true },
          { name: "internalCode", type: "text", label: "Internal code" },
        ],
      },
    },
    t.ctx,
  );
});
afterAll(async () => t.cleanup());

describe("entry.ai_translate", () => {
  it("is disabled without BYOK settings (AI_NOT_CONFIGURED)", async () => {
    delete t.services.llm;
    const source = await entryCreate.run(
      { typeUid: "article", values: { title: "제목" } },
      t.ctx,
    );
    await expect(
      entryAiTranslate.run(
        { typeUid: "article", sourceEntryId: source.entry.id, targetLocale: "en" },
        t.ctx,
      ),
    ).rejects.toMatchObject({ code: "AI_NOT_CONFIGURED" });
  });

  it("creates a draft sibling with translated text and preserved richtext structure", async () => {
    stubLlm();
    const source = await entryCreate.run(
      {
        typeUid: "article",
        values: { title: "안녕", body: validRichtextDoc, publishDate: "2026-08-22" },
      },
      t.ctx,
    );
    const out = await entryAiTranslate.run(
      { typeUid: "article", sourceEntryId: source.entry.id, targetLocale: "en" },
      t.ctx,
    );
    expect(out.entry.locale).toBe("en");
    expect(out.entry.status).toBe("draft");
    expect(out.entry.documentId).toBe(source.entry.documentId);
    expect(out.entry.values.title).toBe("[en] 안녕");
    // richtext: same node structure, only the text node changed
    const body = out.entry.values.body as typeof validRichtextDoc;
    expect(body.content[0]!.type).toBe("paragraph");
    expect(body.content[0]!.content[0]!.text).toContain("[en]");
    // non-text fields copied verbatim
    expect(out.entry.values.publishDate).toBe("2026-08-22");
    // provenance stamped
    expect(out.entry.aiDraft).toMatchObject({
      kind: "translation",
      sourceEntryId: source.entry.id,
      sourceLocale: "ko",
    });
    expect(out.entry.aiDraft!.fields).toEqual(["title", "body"]);
    // the detail view carries a warning advisory while unreviewed
    const detail = await entryGet.run({ typeUid: "article", id: out.entry.id }, t.ctx);
    expect(detail.advisories.some((a) => a.code === "ai-draft-unreviewed")).toBe(true);
  });

  it("never overwrites an existing locale entry (decision ③)", async () => {
    stubLlm();
    const source = await entryCreate.run(
      { typeUid: "article", values: { title: "원본" } },
      t.ctx,
    );
    await entryAiTranslate.run(
      { typeUid: "article", sourceEntryId: source.entry.id, targetLocale: "en" },
      t.ctx,
    );
    await expect(
      entryAiTranslate.run(
        { typeUid: "article", sourceEntryId: source.entry.id, targetLocale: "en" },
        t.ctx,
      ),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("localized flags drive field selection; unflagged text is copied", async () => {
    stubLlm();
    const source = await entryCreate.run(
      { typeUid: "notice", values: { headline: "공지", internalCode: "N-100" } },
      t.ctx,
    );
    const out = await entryAiTranslate.run(
      { typeUid: "notice", sourceEntryId: source.entry.id, targetLocale: "en" },
      t.ctx,
    );
    expect(out.entry.values.headline).toBe("[en] 공지");
    expect(out.entry.values.internalCode).toBe("N-100");
    expect(out.translatedFields).toEqual(["headline"]);
  });

  it("translates the SEO record but drops the canonical override", async () => {
    stubLlm();
    const source = await entryCreate.run(
      { typeUid: "article", values: { title: "SEO글" } },
      t.ctx,
    );
    await entrySetSeo.run(
      {
        typeUid: "article",
        id: source.entry.id,
        seo: {
          metaTitle: "메타 제목",
          canonical: "https://example.com/ko/page",
          noindex: true,
        },
      },
      t.ctx,
    );
    const out = await entryAiTranslate.run(
      { typeUid: "article", sourceEntryId: source.entry.id, targetLocale: "en" },
      t.ctx,
    );
    expect(out.entry.seo?.metaTitle).toBe("[en] 메타 제목");
    expect(out.entry.seo?.canonical).toBeUndefined();
    expect(out.entry.seo?.noindex).toBe(true);
  });

  it("a human save or transition clears the AI-draft mark (review semantics, decision ④)", async () => {
    stubLlm();
    const source = await entryCreate.run(
      { typeUid: "article", values: { title: "검토 대상" } },
      t.ctx,
    );
    const out = await entryAiTranslate.run(
      { typeUid: "article", sourceEntryId: source.entry.id, targetLocale: "en" },
      t.ctx,
    );
    // save clears
    const saved = await entryUpdate.run(
      { typeUid: "article", id: out.entry.id, values: { title: "Reviewed title" } },
      t.ctx,
    );
    expect(saved.entry.aiDraft).toBeNull();
    const detail = await entryGet.run({ typeUid: "article", id: out.entry.id }, t.ctx);
    expect(detail.advisories.some((a) => a.code === "ai-draft-unreviewed")).toBe(false);
    // transition clears too (fresh sibling on another source)
    const source2 = await entryCreate.run(
      { typeUid: "article", values: { title: "전이 대상" } },
      t.ctx,
    );
    const out2 = await entryAiTranslate.run(
      { typeUid: "article", sourceEntryId: source2.entry.id, targetLocale: "en" },
      t.ctx,
    );
    await publishEntry(t.ctx, "article", out2.entry.id);
    const detail2 = await entryGet.run({ typeUid: "article", id: out2.entry.id }, t.ctx);
    expect(detail2.entry.aiDraft).toBeNull();
  });

  it("skips the LLM roundtrip when nothing is translatable", async () => {
    t.services.llm = async () => {
      throw new Error("must not be called");
    };
    const source = await entryCreate.run(
      { typeUid: "article", values: { title: "", publishDate: "2026-01-01" } },
      t.ctx,
    );
    const out = await entryAiTranslate.run(
      { typeUid: "article", sourceEntryId: source.entry.id, targetLocale: "en" },
      t.ctx,
    );
    expect(out.segmentCount).toBe(0);
    expect(out.entry.values.publishDate).toBe("2026-01-01");
  });
});

describe("entry.ai_translate — nesting and limits", () => {
  it("translates text nested in components and dynamic zones", async () => {
    stubLlm();
    const source = await entryCreate.run(
      {
        typeUid: "page",
        values: {
          title: "페이지",
          seo: { meta_title: "메타", keywords: "키워드" },
          blocks: [{ __component: "seo_box", meta_title: "블록 제목" }],
        },
      },
      t.ctx,
    );
    const out = await entryAiTranslate.run(
      { typeUid: "page", sourceEntryId: source.entry.id, targetLocale: "en" },
      t.ctx,
    );
    const v = out.entry.values as Record<string, unknown>;
    expect((v.seo as { meta_title: string }).meta_title).toBe("[en] 메타");
    expect((v.seo as { keywords: string }).keywords).toBe("[en] 키워드");
    const block = (v.blocks as Array<{ __component: string; meta_title: string }>)[0]!;
    expect(block.__component).toBe("seo_box"); // structure untouched
    expect(block.meta_title).toBe("[en] 블록 제목");
    expect(out.translatedFields).toEqual(expect.arrayContaining(["seo", "blocks"]));
  });

  it("trims a translation that exceeds the field's maxLength and reports it", async () => {
    // Stub expands wildly — like Spanish against a tight excerpt limit
    t.services.llm = async ({ user }) => {
      const seg = JSON.parse(user) as Record<string, string>;
      return JSON.stringify(
        Object.fromEntries(
          Object.entries(seg).map(([k, v]) => [
            k,
            k === "f.excerpt" ? v + " padded far beyond the forty character limit" : `[en] ${v}`,
          ]),
        ),
      );
    };
    const source = await entryCreate.run(
      { typeUid: "page", values: { title: "긴 요약", excerpt: "짧은 요약" } },
      t.ctx,
    );
    const out = await entryAiTranslate.run(
      { typeUid: "page", sourceEntryId: source.entry.id, targetLocale: "en" },
      t.ctx,
    );
    const excerpt = out.entry.values.excerpt as string;
    expect(excerpt.length).toBeLessThanOrEqual(40); // entry saved despite the overrun
    expect(out.issues.join()).toContain("f.excerpt");
  });
});

describe("entry.ai_translate — taxonomy carry-over", () => {
  it("copies the source entry's taxonomy attachments to the translated sibling", async () => {
    stubLlm();
    await taxonomyCreate.run({ uid: "topics", name: "Topics" }, t.ctx);
    const node = await taxonomyNodeCreate.run(
      { taxonomyUid: "topics", parentId: null, name: "News", slug: "news" },
      t.ctx,
    );
    const source = await entryCreate.run(
      { typeUid: "article", values: { title: "분류 복사" } },
      t.ctx,
    );
    await entrySetTaxonomies.run(
      {
        typeUid: "article",
        id: source.entry.id,
        attachments: [{ nodeId: node.id, attributeValues: null }],
      },
      t.ctx,
    );
    const out = await entryAiTranslate.run(
      { typeUid: "article", sourceEntryId: source.entry.id, targetLocale: "en" },
      t.ctx,
    );
    const detail = await entryGet.run({ typeUid: "article", id: out.entry.id }, t.ctx);
    expect(detail.taxonomies.map((x: { nodeId: string }) => x.nodeId)).toEqual([node.id]);
  });
});

describe("entry.ai_translate — explicit field selection (translate dialog)", () => {
  it("translates only the selected leaves; unselected text and SEO are copied verbatim", async () => {
    stubLlm();
    const source = await entryCreate.run(
      {
        typeUid: "page",
        values: {
          title: "선택 번역",
          excerpt: "요약",
          seo: { meta_title: "메타", keywords: "키워드" },
          blocks: [{ __component: "seo_box", meta_title: "블록", keywords: "블록키워드" }],
        },
      },
      t.ctx,
    );
    const out = await entryAiTranslate.run(
      {
        typeUid: "page",
        sourceEntryId: source.entry.id,
        targetLocale: "en",
        // dialog selection: title + component meta_title + DZ (component-qualified) meta_title
        fields: ["title", "seo.meta_title", "blocks.seo_box.meta_title"],
        includeSeo: false,
      },
      t.ctx,
    );
    const v = out.entry.values as Record<string, unknown>;
    expect(v.title).toBe("[en] 선택 번역");
    expect(v.excerpt).toBe("요약"); // unselected → copied
    expect((v.seo as { meta_title: string; keywords: string }).meta_title).toBe("[en] 메타");
    expect((v.seo as { keywords: string }).keywords).toBe("키워드"); // unselected nested leaf
    const block = (v.blocks as Array<{ meta_title: string; keywords: string }>)[0]!;
    expect(block.meta_title).toBe("[en] 블록");
    expect(block.keywords).toBe("블록키워드");
    expect(out.translatedFields).toEqual(["title", "seo", "blocks"]);
  });
});

describe("translate segment helpers (pure)", () => {
  it("collects and re-applies media alt overrides", () => {
    const definition = {
      displayField: "t",
      fields: [
        { name: "t", type: "text" },
        { name: "photo", type: "media" },
      ],
    } as never;
    const values = {
      t: "hello",
      photo: [{ id: "0b6f5e7e-0000-4000-8000-000000000001", alt: "대체 텍스트" }],
    };
    const { segments } = collectSegments(definition, values, null);
    expect(segments["a.photo.0"]).toBe("대체 텍스트");
    const applied = applySegments(definition, values, {
      "f.t": "bonjour",
      "a.photo.0": "texte alternatif",
    });
    expect((applied.photo as Array<{ alt: string }>)[0]!.alt).toBe("texte alternatif");
    // source object untouched (deep clone)
    expect((values.photo as Array<{ alt: string }>)[0]!.alt).toBe("대체 텍스트");
  });
});
