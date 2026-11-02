/** 32-IMPL — richtext (ProseMirror JSON) → HTML: schema-driven tags, escaping, images by asset id, Liquid filter */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { richtextToHtml } from "../src/content/richtext/html.js";
import { renderLiquid } from "../src/delivery/liquid.js";
import { setupTestContext, type TestContext } from "./helpers.js";

const t = (text: string, marks?: Array<Record<string, unknown>>) => ({ type: "text", text, ...(marks ? { marks } : {}) });
const p = (content: unknown[], attrs?: Record<string, unknown>) => ({ type: "paragraph", ...(attrs ? { attrs } : {}), content });

describe("richtextToHtml", () => {
  it("renders every node and mark of the schema with the schema's own tags", () => {
    const doc = {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 2, textAlign: "center" }, content: [t("제품 소개")] },
        p([t("안녕 "), t("세상", [{ type: "bold" }]), t(" — "), t("기울임", [{ type: "italic" }]), t(" "), t("코드", [{ type: "code" }]), t(" "), t("취소", [{ type: "strike" }])], { textAlign: "right" }),
        { type: "blockquote", content: [p([t("인용")])] },
        { type: "code_block", attrs: { language: "ts" }, content: [t("const a = 1 < 2;")] },
        { type: "bullet_list", content: [{ type: "list_item", content: [p([t("첫째")])] }] },
        { type: "ordered_list", attrs: { start: 1 }, content: [{ type: "list_item", content: [p([t("하나")])] }, { type: "list_item", content: [p([t("둘")])] }] },
        { type: "image", attrs: { assetId: "asset-1", src: "https://old.example/x.png", alt: "사진" } },
        { type: "horizontal_rule" },
        p([t("줄"), { type: "hard_break" }, t("바꿈")]),
        p([t("링크", [{ type: "link", attrs: { href: "https://prina.dev/?a=1&b=2" } }, { type: "bold" }])]),
      ],
    };
    expect(richtextToHtml(doc)).toBe(
      '<h2 style="text-align: center">제품 소개</h2>' +
      '<p style="text-align: right">안녕 <strong>세상</strong> — <em>기울임</em> <code>코드</code> <s>취소</s></p>' +
      "<blockquote><p>인용</p></blockquote>" +
      "<pre><code>const a = 1 &lt; 2;</code></pre>" +
      "<ul><li><p>첫째</p></li></ul>" +
      "<ol><li><p>하나</p></li><li><p>둘</p></li></ol>" +
      '<img src="/delivery/assets/asset-1" alt="사진">' +
      "<hr>" +
      "<p>줄<br>바꿈</p>" +
      // marks nest in schema order (bold declared before link) — the same nesting the editor's DOMSerializer emits
      '<p><strong><a href="https://prina.dev/?a=1&amp;b=2">링크</a></strong></p>',
    );
  });

  it("escapes editor text and attribute values — typed tags never become markup", () => {
    const doc = { type: "doc", content: [p([t('<script>alert("x")</script> & "따옴표"')]), { type: "image", attrs: { src: 'x" onerror="1', alt: "<b>" } }] };
    const html = richtextToHtml(doc);
    expect(html).toBe('<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &quot;따옴표&quot;</p><img src="x&quot; onerror=&quot;1" alt="&lt;b&gt;">');
    expect(html).not.toContain("<script>");
  });

  it("images: asset id wins over src, src alone is kept, neither drops the tag; assetUrl is injectable", () => {
    const img = (attrs: Record<string, unknown>) => ({ type: "doc", content: [{ type: "image", attrs }] });
    expect(richtextToHtml(img({ assetId: "a1", src: "https://x/y.png" }))).toBe('<img src="/delivery/assets/a1" alt="">');
    expect(richtextToHtml(img({ src: "https://x/y.png", alt: "y" }))).toBe('<img src="https://x/y.png" alt="y">');
    expect(richtextToHtml(img({ alt: "nothing" }))).toBe("");
    expect(richtextToHtml(img({ assetId: "a1" }), (id) => `https://cdn.example/${id}`)).toBe('<img src="https://cdn.example/a1" alt="">');
  });

  it("null and schema violations render as an empty string, not an error", () => {
    expect(richtextToHtml(null)).toBe("");
    expect(richtextToHtml(undefined)).toBe("");
    expect(richtextToHtml("plain string")).toBe("");
    expect(richtextToHtml({ type: "doc", content: [{ type: "nope" }] })).toBe("");
    expect(richtextToHtml({ type: "doc", content: [] })).toBe(""); // block+ violated
  });
});

describe("Liquid richtext_to_html", () => {
  let ctx: TestContext;
  beforeAll(async () => { ctx = await setupTestContext(); });
  afterAll(async () => ctx.cleanup());

  it("{{ values.content | richtext_to_html }} outputs the HTML unescaped; the bare value would be [object Object]", async () => {
    const scope = { values: { title: "제품 A", content: { type: "doc", content: [p([t("안녕 "), t("세상", [{ type: "bold" }])])] } } };
    const html = await renderLiquid({
      liquid: `<h1>{{ values.title }}</h1><div class="body">{{ values.content | richtext_to_html }}</div><!--{{ values.content }}-->`,
      scope: scope as never,
      storage: ctx.services.storage,
    });
    expect(html).toBe('<h1>제품 A</h1><div class="body"><p>안녕 <strong>세상</strong></p></div><!--[object Object]-->');
  });
});
