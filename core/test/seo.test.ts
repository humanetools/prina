/** SEO axis (§0.11 Phase 1): entry SEO record, type options, head emission, publish gate */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { EntryStatus } from "@prina/shared";
import { buildApp } from "../src/app.js";
import { createDb } from "../src/db/client.js";
import { contentVersions } from "../src/db/schema/index.js";
import {
  contentTypeCreate,
  contentTypeGet,
  contentTypeUpdate,
} from "../src/modules/content-type/commands.js";
import { entryCreate, entryGet } from "../src/modules/entry/commands.js";
import { entrySetSeo } from "../src/modules/entry/seo.js";
import { entryTransition } from "../src/modules/entry/transition-commands.js";
import { workspaceUpdateSettings } from "../src/modules/workspace/commands.js";
import {
  buildHeadTags,
  interpolateUrlPattern,
  resolveEntryUrl,
  serializeHeadTags,
} from "../src/delivery/seo.js";
import { ValidationError } from "../src/lib/errors.js";
import { publishEntry, setupTestContext, type TestContext } from "./helpers.js";

let t: TestContext;
let app: FastifyInstance;
let entryId: string;

const ARTICLE_DEF = {
  fields: [
    { name: "title", type: "text", required: true },
    { name: "slug", type: "uid", targetField: "title" },
  ],
  displayField: "title",
};

const SEO_OPTIONS = {
  seo: {
    enabled: true,
    urlPattern: "/articles/{slug}",
    sitemap: { include: true },
  },
};

/** Walks intermediate workflow states (EE 4-stage) and returns the publish attempt itself */
async function attemptPublish(typeUid: string, id: string) {
  for (const to of [EntryStatus.Review, EntryStatus.Approved]) {
    try {
      await entryTransition.run({ typeUid, id, to }, t.ctx);
    } catch {
      // transition not defined in the core default workflow — fine
    }
  }
  return entryTransition.run({ typeUid, id, to: EntryStatus.Published }, t.ctx);
}

beforeAll(async () => {
  t = await setupTestContext();
  const { db } = createDb(process.env.TEST_DATABASE_URL!);
  app = buildApp({
    env: { LOG_LEVEL: "error", NODE_ENV: "test", ADMIN_DIST_PATH: undefined, S3_REGION: "us-east-1" },
    db,
    services: t.services,
  });
  await workspaceUpdateSettings.run(
    { settings: { seo: { siteBaseUrl: "https://example.com", titleSuffix: " | Acme" } } },
    t.ctx,
  );
  await contentTypeCreate.run(
    {
      uid: "article",
      name: "Article",
      schemaOrgType: "Article",
      options: SEO_OPTIONS,
      definition: ARTICLE_DEF,
    },
    t.ctx,
  );
  const created = await entryCreate.run(
    { typeUid: "article", values: { title: "Hello SEO", slug: "hello-seo" } },
    t.ctx,
  );
  entryId = created.entry.id;
});

afterAll(async () => {
  await app.close();
  await t.cleanup();
});

describe("URL resolution (delivery/seo.ts)", () => {
  const entry = { id: "e-1", documentId: "d-1", locale: "ko" };

  it("interpolates tokens and voids the URL on a missing token", () => {
    expect(interpolateUrlPattern("/a/{slug}", entry, { slug: "x-1" })).toBe("/a/x-1");
    expect(interpolateUrlPattern("/a/{slug}/{locale}", entry, { slug: "x" })).toBe("/a/x/ko");
    expect(interpolateUrlPattern("/a/{slug}", entry, {})).toBeNull();
    expect(interpolateUrlPattern("/a/{slug}", entry, { slug: "" })).toBeNull();
    expect(interpolateUrlPattern("/a/{slug}", entry, { slug: { o: 1 } })).toBeNull();
  });

  it("prefers the per-entry canonical and never emits without baseUrl+pattern", () => {
    const base = {
      typeOptions: { enabled: true, urlPattern: "/p/{slug}" },
      workspaceSeo: { siteBaseUrl: "https://site.io" },
      entry,
      values: { slug: "s" },
      displayValue: null,
    };
    expect(resolveEntryUrl({ ...base, seo: { canonical: "https://o.io/x" } })).toBe("https://o.io/x");
    expect(resolveEntryUrl({ ...base, seo: null })).toBe("https://site.io/p/s");
    expect(resolveEntryUrl({ ...base, seo: null, workspaceSeo: null })).toBeNull();
    expect(resolveEntryUrl({ ...base, seo: null, typeOptions: { enabled: true } })).toBeNull();
  });

  it("builds head tags with fallbacks and escaping", () => {
    const tags = buildHeadTags({
      seo: { metaDescription: 'A "desc" <here>' },
      typeOptions: { enabled: true, urlPattern: "/p/{slug}" },
      workspaceSeo: { siteBaseUrl: "https://site.io", titleSuffix: " | Acme" },
      entry,
      values: { slug: "s" },
      displayValue: "Fallback Title",
      schemaOrgType: "Article",
    });
    expect(tags.title).toBe("Fallback Title | Acme");
    expect(tags.link).toEqual([{ rel: "canonical", href: "https://site.io/p/s" }]);
    expect(tags.meta).toContainEqual({ property: "og:type", content: "article" });
    const html = serializeHeadTags(tags);
    expect(html).toContain("&quot;desc&quot; &lt;here&gt;");
    expect(html).not.toContain("<here>");
  });
});

describe("type options (content_types.options.seo)", () => {
  it("persists through create, merges on update, keeps unknown keys, no version bump", async () => {
    const before = await contentTypeGet.run({ uid: "article" }, t.ctx);
    expect((before.options as Record<string, unknown>).seo).toMatchObject({ enabled: true });

    await contentTypeUpdate.run(
      { uid: "article", options: { other: { flag: 1 } } as never },
      t.ctx,
    );
    const after = await contentTypeGet.run({ uid: "article" }, t.ctx);
    expect((after.options as Record<string, unknown>).seo).toMatchObject({ enabled: true });
    expect((after.options as Record<string, unknown>).other).toEqual({ flag: 1 });
    expect(after.version).toBe(before.version);
  });

  it("rejects an invalid seo options shape", async () => {
    await expect(
      contentTypeUpdate.run(
        { uid: "article", options: { seo: { enabled: "yes" } } as never },
        t.ctx,
      ),
    ).rejects.toThrow();
  });
});

describe("entry SEO record (PUT …/seo)", () => {
  it("saves, returns via entryGet, and snapshots into the version history", async () => {
    await entrySetSeo.run(
      {
        typeUid: "article",
        id: entryId,
        seo: { metaTitle: "Hello SEO — guide", metaDescription: "d".repeat(80) },
      },
      t.ctx,
    );
    const detail = await entryGet.run({ typeUid: "article", id: entryId }, t.ctx);
    expect(detail.entry.seo).toMatchObject({ metaTitle: "Hello SEO — guide" });

    const [latest] = await t.db
      .select()
      .from(contentVersions)
      .where(eq(contentVersions.entryId, entryId))
      .orderBy(desc(contentVersions.version))
      .limit(1);
    expect(latest!.snapshot.seo).toMatchObject({ metaTitle: "Hello SEO — guide" });
    expect(latest!.diff).toHaveProperty("__seo");
  });

  it("rejects a relative canonical URL", async () => {
    await expect(
      entrySetSeo.run(
        { typeUid: "article", id: entryId, seo: { canonical: "/relative" } },
        t.ctx,
      ),
    ).rejects.toThrow();
  });
});

describe("advisories & publish gate", () => {
  it("entryGet surfaces advisories for an SEO-enabled type", async () => {
    const detail = await entryGet.run({ typeUid: "article", id: entryId }, t.ctx);
    // metaTitle/description are set above; the resolved URL exists → no error-severity items
    expect(detail.advisories.filter((a) => a.severity === "error")).toEqual([]);
  });

  it("default mode publishes despite missing SEO; strict mode blocks with advisories", async () => {
    const bare = await entryCreate.run(
      { typeUid: "article", values: { title: "No SEO yet", slug: "no-seo" } },
      t.ctx,
    );
    await publishEntry(t.ctx, "article", bare.entry.id); // warn-only default must not block
    const published = await entryGet.run({ typeUid: "article", id: bare.entry.id }, t.ctx);
    expect(published.entry.status).toBe(EntryStatus.Published);

    await contentTypeUpdate.run(
      {
        uid: "article",
        options: { seo: { ...SEO_OPTIONS.seo, strictPublish: true } },
      },
      t.ctx,
    );
    const strict = await entryCreate.run(
      { typeUid: "article", values: { title: "Strict entry", slug: "strict-entry" } },
      t.ctx,
    );
    try {
      await attemptPublish("article", strict.entry.id);
      expect.unreachable("strict publish should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      const details = (err as ValidationError).details as { advisories: Array<{ code: string }> };
      expect(details.advisories.map((a) => a.code)).toContain("seo-meta-description-missing");
    }
    // Filling the record clears the gate
    await entrySetSeo.run(
      {
        typeUid: "article",
        id: strict.entry.id,
        seo: { metaTitle: "Strict entry", metaDescription: "d".repeat(80) },
      },
      t.ctx,
    );
    const ok = await entryTransition.run(
      { typeUid: "article", id: strict.entry.id, to: EntryStatus.Published },
      t.ctx,
    );
    expect(ok.to).toBe(EntryStatus.Published);
    // restore non-strict for later tests
    await contentTypeUpdate.run({ uid: "article", options: SEO_OPTIONS }, t.ctx);
  });
});

describe("delivery emission", () => {
  it("format=head returns title/canonical/OG and JSON-LD", async () => {
    await publishEntry(t.ctx, "article", entryId);
    const res = await app.inject({
      method: "GET",
      url: `/delivery/article/${entryId}?format=head&ws=${t.workspaceSlug}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.body;
    expect(body).toContain("<title>Hello SEO — guide | Acme</title>");
    expect(body).toContain('<link rel="canonical" href="https://example.com/articles/hello-seo">');
    expect(body).toContain('property="og:title"');
    expect(body).toContain('application/ld+json');
  });

  it("JSON mode carries the seo payload and the list resolves urls", async () => {
    const single = await app.inject({
      method: "GET",
      url: `/delivery/article/${entryId}?ws=${t.workspaceSlug}`,
    });
    const seo = single.json().seo;
    expect(seo.url).toBe("https://example.com/articles/hello-seo");
    expect(seo.record.metaTitle).toBe("Hello SEO — guide");

    const list = await app.inject({
      method: "GET",
      url: `/delivery/article?ws=${t.workspaceSlug}`,
    });
    const item = list
      .json()
      .items.find((i: { id: string }) => i.id === entryId);
    expect(item.url).toBe("https://example.com/articles/hello-seo");
  });

  it("fragment and embed modes attach the seo payload", async () => {
    const { templateSave } = await import("../src/modules/template/commands.js");
    await templateSave.run(
      { typeUid: "article", liquid: "<h2>{{ values.title }}</h2>", css: "" },
      t.ctx,
    );
    const frag = await app.inject({
      method: "GET",
      url: `/delivery/article/${entryId}?format=html&ws=${t.workspaceSlug}`,
    });
    expect(frag.statusCode).toBe(200);
    expect(frag.body).toContain('class="prina-seo"');
    expect(frag.body).toContain("articles/hello-seo");

    const embed = await app.inject({
      method: "GET",
      url: `/delivery/article/${entryId}?format=html&embed=1&ws=${t.workspaceSlug}`,
    });
    expect(embed.statusCode).toBe(200);
    expect(embed.json().seo.url).toBe("https://example.com/articles/hello-seo");
    expect(embed.json().seo.title).toBe("Hello SEO — guide | Acme");
  });

  it("format=head 404s for a type without SEO configuration", async () => {
    await contentTypeCreate.run(
      { uid: "plain", name: "Plain", definition: { fields: [{ name: "title", type: "text" }] } },
      t.ctx,
    );
    const created = await entryCreate.run(
      { typeUid: "plain", values: { title: "x" } },
      t.ctx,
    );
    await publishEntry(t.ctx, "plain", created.entry.id);
    const res = await app.inject({
      method: "GET",
      url: `/delivery/plain/${created.entry.id}?format=head&ws=${t.workspaceSlug}`,
    });
    expect(res.statusCode).toBe(404);
  });
});
