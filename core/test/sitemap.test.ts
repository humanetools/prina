/** GEO surfaces (§0.11 Phase 2): sitemap.xml, robots.txt, llms.txt */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createDb } from "../src/db/client.js";
import { contentTypeCreate } from "../src/modules/content-type/commands.js";
import { entryCreate } from "../src/modules/entry/commands.js";
import { entrySetSeo } from "../src/modules/entry/seo.js";
import { workspaceUpdateSettings } from "../src/modules/workspace/commands.js";
import { publishEntry, setupTestContext, type TestContext } from "./helpers.js";

let t: TestContext;
let app: FastifyInstance;
let pageId: string;
let noindexId: string;

beforeAll(async () => {
  t = await setupTestContext();
  const { db } = createDb(process.env.TEST_DATABASE_URL!);
  app = buildApp({
    env: { LOG_LEVEL: "error", NODE_ENV: "test", ADMIN_DIST_PATH: undefined, S3_REGION: "us-east-1" },
    db,
    services: t.services,
  });
  await workspaceUpdateSettings.run(
    {
      settings: {
        seo: {
          siteBaseUrl: "https://example.com",
          robots: { extraDisallow: ["/private"] },
        },
      },
    },
    t.ctx,
  );
  // page: in sitemap · doc: SEO on but sitemap off · plain: SEO off entirely
  await contentTypeCreate.run(
    {
      uid: "page",
      name: "Page",
      schemaOrgType: "Article",
      description: "Marketing pages",
      options: { seo: { enabled: true, urlPattern: "/p/{slug}", sitemap: { include: true, priority: 0.8, changefreq: "weekly" } } },
      definition: {
        fields: [
          { name: "title", type: "text", required: true },
          { name: "slug", type: "uid", targetField: "title" },
        ],
        displayField: "title",
      },
    },
    t.ctx,
  );
  await contentTypeCreate.run(
    {
      uid: "doc",
      name: "Doc",
      options: { seo: { enabled: true, urlPattern: "/d/{slug}" } },
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
  await contentTypeCreate.run(
    { uid: "plain", name: "Plain", definition: { fields: [{ name: "title", type: "text" }] } },
    t.ctx,
  );

  const page = await entryCreate.run(
    { typeUid: "page", values: { title: "Landing", slug: "landing" } },
    t.ctx,
  );
  pageId = page.entry.id;
  await entrySetSeo.run(
    { typeUid: "page", id: pageId, seo: { metaDescription: "The landing page." } },
    t.ctx,
  );
  await publishEntry(t.ctx, "page", pageId);

  const hidden = await entryCreate.run(
    { typeUid: "page", values: { title: "Hidden", slug: "hidden" } },
    t.ctx,
  );
  noindexId = hidden.entry.id;
  await entrySetSeo.run({ typeUid: "page", id: noindexId, seo: { noindex: true } }, t.ctx);
  await publishEntry(t.ctx, "page", noindexId);

  const draft = await entryCreate.run(
    { typeUid: "page", values: { title: "Draft only", slug: "draft-only" } },
    t.ctx,
  );
  void draft;

  const doc = await entryCreate.run(
    { typeUid: "doc", values: { title: "Guide", slug: "guide" } },
    t.ctx,
  );
  await publishEntry(t.ctx, "doc", doc.entry.id);

  const plain = await entryCreate.run({ typeUid: "plain", values: { title: "x" } }, t.ctx);
  await publishEntry(t.ctx, "plain", plain.entry.id);
});

afterAll(async () => {
  await app.close();
  await t.cleanup();
});

describe("sitemap.xml", () => {
  it("lists only published entries of sitemap-included types, minus noindex", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/delivery/sitemap.xml?ws=${t.workspaceSlug}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/xml");
    expect(res.headers["cache-control"]).toContain("s-maxage=3600");
    const xml = res.body;
    expect(xml).toContain("<loc>https://example.com/p/landing</loc>");
    expect(xml).toContain("<changefreq>weekly</changefreq>");
    expect(xml).toContain("<priority>0.8</priority>");
    expect(xml).toMatch(/<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/);
    expect(xml).not.toContain("/p/hidden"); // noindex
    expect(xml).not.toContain("/p/draft-only"); // draft
    expect(xml).not.toContain("/d/guide"); // sitemap.include off
  });

  it("ignores draft tokens — surfaces are published-only", async () => {
    const { issueDraftToken } = await import("../src/modules/delivery/token.js");
    const { token } = await issueDraftToken(t.db, t.workspaceSlug, 1);
    const res = await app.inject({
      method: "GET",
      url: `/delivery/sitemap.xml?ws=${t.workspaceSlug}&draft=${token}`,
    });
    expect(res.body).not.toContain("/p/draft-only");
    expect(res.headers["cache-control"]).toContain("public");
  });
});

describe("external canonical pattern (syndicated collections)", () => {
  it("emits the external canonical and excludes those entries from the sitemap", async () => {
    await contentTypeCreate.run(
      {
        uid: "repost",
        name: "Repost",
        options: {
          seo: {
            enabled: true,
            urlPattern: "/r/{slug}",
            externalCanonicalPattern: "https://origin.example.org/posts/{slug}",
            sitemap: { include: true },
          },
        },
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
      { typeUid: "repost", values: { title: "Syndicated", slug: "syndicated" } },
      t.ctx,
    );
    await publishEntry(t.ctx, "repost", created.entry.id);

    const head = await app.inject({
      method: "GET",
      url: `/delivery/repost/${created.entry.id}?format=head&ws=${t.workspaceSlug}`,
    });
    expect(head.body).toContain(
      '<link rel="canonical" href="https://origin.example.org/posts/syndicated">',
    );

    const sitemap = await app.inject({
      method: "GET",
      url: `/delivery/sitemap.xml?ws=${t.workspaceSlug}`,
    });
    // canonical points elsewhere → neither the own URL nor the external one may be listed
    expect(sitemap.body).not.toContain("/r/syndicated");
    expect(sitemap.body).not.toContain("origin.example.org");

    // llms.txt links agents to the original
    const llms = await app.inject({
      method: "GET",
      url: `/delivery/llms.txt?ws=${t.workspaceSlug}`,
    });
    expect(llms.body).toContain("[Syndicated](https://origin.example.org/posts/syndicated)");
  });
});

describe("robots.txt", () => {
  it("emits disallow rules and an absolute sitemap reference", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/delivery/robots.txt?ws=${t.workspaceSlug}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("User-agent: *");
    expect(res.body).toContain("Disallow: /private");
    expect(res.body).toMatch(/Sitemap: https?:\/\/.+\/delivery\/sitemap\.xml\?ws=/);
  });
});

describe("llms.txt", () => {
  it("surveys SEO-enabled types with links and descriptions", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/delivery/llms.txt?ws=${t.workspaceSlug}`,
    });
    expect(res.statusCode).toBe(200);
    const txt = res.body;
    expect(txt).toContain("## Page (schema.org Article)");
    expect(txt).toContain("> Marketing pages");
    expect(txt).toContain("[Landing](https://example.com/p/landing): The landing page.");
    // doc has no sitemap include but IS seo-enabled → listed, with a delivery URL fallback? (has urlPattern → canonical)
    expect(txt).toContain("## Doc");
    expect(txt).toContain("[Guide](https://example.com/d/guide)");
    // plain type (no SEO) and noindex/draft entries stay out
    expect(txt).not.toContain("## Plain");
    expect(txt).not.toContain("Hidden");
    expect(txt).not.toContain("Draft only");
  });

  it("returns valid empty documents for a workspace with no SEO types", async () => {
    const t2 = await setupTestContext();
    try {
      const res = await app.inject({
        method: "GET",
        url: `/delivery/sitemap.xml?ws=${t2.workspaceSlug}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain("<urlset");
      const llms = await app.inject({
        method: "GET",
        url: `/delivery/llms.txt?ws=${t2.workspaceSlug}`,
      });
      expect(llms.statusCode).toBe(200);
    } finally {
      await t2.cleanup();
    }
  });
});
