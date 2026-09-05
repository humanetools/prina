/** Preview audit engine (§0.11 WA axis) — server-side structure rules + preview integration */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditRenderedHtml } from "../src/delivery/audit.js";
import { contentTypeCreate } from "../src/modules/content-type/commands.js";
import { entryCreate } from "../src/modules/entry/commands.js";
import { templateRenderPreview } from "../src/modules/template/commands.js";
import { workspaceUpdateSettings } from "../src/modules/workspace/commands.js";
import { setupTestContext, type TestContext } from "./helpers.js";

describe("auditRenderedHtml", () => {
  it("flags images without alt, but not decorative alt=\"\"", () => {
    const findings = auditRenderedHtml(
      `<div><img src="a.jpg"><img src="b.jpg" alt=""><img src="c.jpg" alt="desc"></div>`,
    );
    const rules = findings.map((f) => f.rule);
    expect(rules).toEqual(["img-alt-missing"]);
    expect(findings[0]!.selectorPath).toBe("div:nth-child(1) > img:nth-child(1)");
    expect(findings[0]!.severity).toBe("error");
  });

  it("flags empty accessible names on links and buttons, honoring aria-label and img alt", () => {
    const findings = auditRenderedHtml(
      `<a href="/x"></a>` +
        `<a href="/y" aria-label="Go"></a>` +
        `<a href="/z"><img src="i.png" alt="Logo"></a>` +
        `<button></button>` +
        `<button aria-label="Close"></button>`,
    );
    expect(findings.map((f) => f.rule).sort()).toEqual(["button-name-empty", "link-name-empty"]);
  });

  it("flags heading order skips and multiple h1s, not proper sequences", () => {
    const bad = auditRenderedHtml(`<h1>A</h1><h4>B</h4><h1>C</h1>`);
    expect(bad.map((f) => f.rule).sort()).toEqual(["heading-order", "multiple-h1"]);
    const good = auditRenderedHtml(`<h2>A</h2><h3>B</h3><h2>C</h2>`);
    expect(good).toEqual([]);
  });

  it("flags iframes without title", () => {
    const findings = auditRenderedHtml(`<iframe src="https://x"></iframe>`);
    expect(findings[0]!.rule).toBe("iframe-title-missing");
  });

  it("computes nested selector paths with element-only indexes", () => {
    const findings = auditRenderedHtml(
      `<section>text<div><p>hi</p><img src="x"></div></section>`,
    );
    expect(findings[0]!.selectorPath).toBe(
      "section:nth-child(1) > div:nth-child(1) > img:nth-child(2)",
    );
  });
});

describe("templateRenderPreview integration", () => {
  let t: TestContext;
  let entryId: string;

  beforeAll(async () => {
    t = await setupTestContext();
    await workspaceUpdateSettings.run(
      { settings: { seo: { siteBaseUrl: "https://example.com" } } },
      t.ctx,
    );
    await contentTypeCreate.run(
      {
        uid: "note",
        name: "Note",
        options: { seo: { enabled: true, urlPattern: "/n/{slug}" } },
        definition: {
          fields: [
            { name: "title", type: "text" },
            { name: "slug", type: "uid", targetField: "title" },
          ],
          displayField: "title",
        },
      },
      t.ctx,
    );
    const created = await entryCreate.run(
      { typeUid: "note", values: { title: "Audit me", slug: "audit-me" } },
      t.ctx,
    );
    entryId = created.entry.id;
  });

  afterAll(async () => {
    await t.cleanup();
  });

  it("returns head + merged structure/SEO checks", async () => {
    const res = await templateRenderPreview.run(
      {
        typeUid: "note",
        entryId,
        liquid: `<h2>{{ values.title }}</h2><img src="cover.jpg">`,
        css: "",
      },
      t.ctx,
    );
    expect(res.html).toContain("Audit me");
    expect(res.head).toContain('<link rel="canonical" href="https://example.com/n/audit-me">');
    const rules = res.checks.map((c) => c.rule);
    expect(rules).toContain("img-alt-missing");
    expect(rules).toContain("seo-meta-description-missing");
  });

  it("omits head and SEO checks for types without the SEO option", async () => {
    await contentTypeCreate.run(
      { uid: "bare", name: "Bare", definition: { fields: [{ name: "title", type: "text" }] } },
      t.ctx,
    );
    const created = await entryCreate.run(
      { typeUid: "bare", values: { title: "x" } },
      t.ctx,
    );
    const res = await templateRenderPreview.run(
      { typeUid: "bare", entryId: created.entry.id, liquid: `<p>ok</p>`, css: "" },
      t.ctx,
    );
    expect(res.head).toBeNull();
    expect(res.checks).toEqual([]);
  });
});
