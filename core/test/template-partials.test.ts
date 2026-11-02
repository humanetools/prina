/**
 * 39-IMPL A0 — authoring foundations in core:
 *  C1 dynamic-zone block ids, nesting inside components (depth-bounded), locked/maxDepth options
 *  C2 preview with unsaved values + edit-marked partial variants
 *  C3 template partials ({% render %}), partial script delivery, recursion guard
 *  C4 single-type text fields served as files (/delivery/<single>/<field>.css) with ETag
 *  C5 reserved `partials` type uid, read-POST scope for partial render
 * 40-IMPL component markup: components.options.markup toggle, partial css (style.css, <link>, embed css),
 *  list flags, version activate, 409 when the toggle is off
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { ContentTypeKind, DefaultRole } from "@prina/shared";
import { buildApp } from "../src/app.js";
import { createDb } from "../src/db/client.js";
import { entries, templatePartials } from "../src/db/schema/index.js";
import { contentTypeCreate } from "../src/modules/content-type/commands.js";
import { componentCreate, componentList, componentUpdate } from "../src/modules/content-type/component-commands.js";
import { entryCreate, entryUpdate } from "../src/modules/entry/commands.js";
import { templateRenderPreview, templateSave } from "../src/modules/template/commands.js";
import {
  ComponentMarkupDisabledError,
  partialDelete,
  partialGet,
  partialList,
  partialRender,
  partialSave,
  partialSetCurrent,
} from "../src/modules/template/partial-commands.js";
import { requiredScopeFor } from "../src/http/api-scopes.js";
import { ForbiddenError, ValidationError } from "../src/lib/errors.js";
import { publishEntry, setupTestContext, type TestContext } from "./helpers.js";

let t: TestContext;
let app: FastifyInstance;
let pageId: string;

const HERO = `<section class="hero"><h1>{{ blk.title | escape }}</h1>{% if blk.opt_badge %}<b>NEW</b>{% endif %}</section>`;
const HERO_EDIT = `<section class="hero" data-blk="{{ blk._id }}"><h1 data-prop="title">{{ blk.title | escape }}</h1>{% if blk.opt_badge %}<b>NEW</b>{% endif %}</section>`;
const CARD = `<article class="card"><h3>{{ blk.title | escape }}</h3>{% render 'ds.badge' with blk as blk %}</article>`;
const BADGE = `<span class="badge">{{ blk.kind | default: "plain" }}</span>`;
const PAGE_LIQUID = `<main>{% for blk in values.sections %}{% render blk.__component with blk as blk %}{% endfor %}</main>`;

beforeAll(async () => {
  t = await setupTestContext();
  const { db } = createDb(process.env.TEST_DATABASE_URL!);
  app = buildApp({
    env: { LOG_LEVEL: "error", NODE_ENV: "test", ADMIN_DIST_PATH: undefined, S3_REGION: "us-east-1" },
    db,
    services: t.services,
  });

  await componentCreate.run(
    { uid: "ds.hero", name: "Hero", options: { markup: true }, definition: { fields: [{ name: "title", type: "text" }, { name: "opt_badge", type: "boolean" }] } },
    t.ctx,
  );
  await componentCreate.run(
    { uid: "ds.card", name: "Card", options: { markup: true }, definition: { fields: [{ name: "title", type: "text" }, { name: "kind", type: "text" }] } },
    t.ctx,
  );
  await contentTypeCreate.run(
    {
      uid: "landing",
      name: "Landing",
      definition: {
        fields: [
          { name: "title", type: "text", required: true },
          { name: "sections", type: "dynamic_zone", components: ["ds.hero", "ds.card"] },
        ],
        displayField: "title",
      },
    },
    t.ctx,
  );
  await partialSave.run({ name: "ds.hero", liquid: HERO, liquidEdit: HERO_EDIT, js: "window.__hero = (window.__hero||0)+1;" }, t.ctx);
  await partialSave.run({ name: "ds.card", liquid: CARD }, t.ctx);
  await partialSave.run({ name: "ds.badge", liquid: BADGE }, t.ctx);
  await templateSave.run({ typeUid: "landing", liquid: PAGE_LIQUID, css: ".hero { color: red }" }, t.ctx);

  const page = await entryCreate.run(
    {
      typeUid: "landing",
      values: {
        title: "랜딩",
        sections: [
          { __component: "ds.hero", title: "Hello <World>", opt_badge: true },
          { __component: "ds.card", title: "Card A", kind: "accent" },
          { __component: "ds.card", title: "Card B", _id: "fixed-01" },
        ],
      },
    },
    t.ctx,
  );
  pageId = page.entry.id;
  await publishEntry(t.ctx, "landing", pageId);
});

afterAll(async () => {
  await app.close();
  await t.cleanup();
});

describe("C1 — dynamic-zone block ids", () => {
  it("assigns a stable 8-char _id to blocks saved without one and keeps client-provided ids", async () => {
    const [row] = await t.db.select({ values: entries.values }).from(entries).where(eq(entries.id, pageId));
    const ids = (row!.values as { sections: Array<Record<string, unknown>> }).sections.map((b) => b._id);
    expect(ids[2]).toBe("fixed-01");
    expect(typeof ids[0]).toBe("string");
    expect((ids[0] as string).length).toBe(8);
    expect(new Set(ids).size).toBe(3);
  });

  it("keeps ids across a re-save and only fills the blocks that lack one", async () => {
    const before = (await app.inject({ method: "GET", url: `/delivery/landing/${pageId}?ws=${t.workspaceSlug}` })).json();
    const sections = before.values.sections as Array<Record<string, unknown>>;
    const kept = sections[0]!._id;
    const next = [...sections, { __component: "ds.card", title: "Card C" }];
    const saved = await entryUpdate.run({ typeUid: "landing", id: pageId, values: { title: "랜딩", sections: next } }, t.ctx);
    const after = (saved.entry.values as { sections: Array<Record<string, unknown>> }).sections;
    expect(after[0]!._id).toBe(kept);
    expect(after[2]!._id).toBe("fixed-01");
    expect(typeof after[3]!._id).toBe("string");
  });
});

describe("C1 — nesting inside components, bounded by maxDepth", () => {
  it("a component may hold a repeatable component and a dynamic zone (even of itself); depth is enforced", async () => {
    await componentCreate.run(
      {
        uid: "ds.grid",
        name: "Grid",
        definition: {
          fields: [
            { name: "heading", type: "text" },
            { name: "cards", type: "component", component: "ds.card", repeatable: true },
            // self-referencing zone — compiles because the schema compiler stops at maxDepth
            { name: "inner", type: "dynamic_zone", components: ["ds.grid"] },
          ],
        },
      },
      t.ctx,
    );
    await contentTypeCreate.run(
      {
        uid: "nest_page",
        name: "Nest",
        definition: {
          fields: [
            { name: "title", type: "text" },
            { name: "sections", type: "dynamic_zone", components: ["ds.grid"], maxDepth: 2, locked: true },
          ],
        },
      },
      t.ctx,
    );
    const ok = await entryCreate.run(
      {
        typeUid: "nest_page",
        values: {
          title: "n",
          sections: [
            {
              __component: "ds.grid",
              heading: "L1",
              cards: [{ title: "c1" }, { title: "c2", kind: "x" }],
              inner: [{ __component: "ds.grid", heading: "L2", cards: [], inner: [] }],
            },
          ],
        },
      },
      t.ctx,
    );
    const l1 = (ok.entry.values as { sections: Array<Record<string, unknown>> }).sections[0]!;
    const l2 = (l1.inner as Array<Record<string, unknown>>)[0]!;
    expect(typeof l1._id).toBe("string");
    expect(typeof l2._id).toBe("string"); // nested zone blocks get ids too

    // depth 3 exceeds maxDepth 2 → the innermost zone must be empty
    await expect(
      entryCreate.run(
        {
          typeUid: "nest_page",
          values: {
            title: "deep",
            sections: [
              {
                __component: "ds.grid",
                heading: "L1",
                inner: [{ __component: "ds.grid", heading: "L2", inner: [{ __component: "ds.grid", heading: "L3" }] }],
              },
            ],
          },
        },
        t.ctx,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("C3 — template partials", () => {
  it("save versions, list, get, delete; names are validated", async () => {
    const v2 = await partialSave.run({ name: "ds.badge", liquid: BADGE + "<!-- v2 -->" }, t.ctx);
    expect(v2.version).toBe(2);
    const got = await partialGet.run({ name: "ds.badge" }, t.ctx);
    expect(got.current.version).toBe(2);
    expect(got.versions.map((v) => v.version)).toEqual([2, 1]);
    const list = await partialList.run({}, t.ctx);
    expect(list.map((p) => p.name)).toEqual(["ds.badge", "ds.card", "ds.hero"]);
    expect(list.find((p) => p.name === "ds.hero")).toMatchObject({ hasJs: true, hasEditVariant: true });

    await expect(partialSave.run({ name: "Bad Name", liquid: "x" }, t.ctx)).rejects.toBeInstanceOf(ValidationError);
    await expect(partialGet.run({ name: "ds.nope" }, t.ctx)).rejects.toThrow(/not found/);

    await partialSave.run({ name: "tmp.gone", liquid: "x" }, t.ctx);
    const del = await partialDelete.run({ name: "tmp.gone" }, t.ctx);
    expect(del.deleted).toBe(1);
    await expect(partialGet.run({ name: "tmp.gone" }, t.ctx)).rejects.toThrow(/not found/);
  });

  it("js follows the template_script lock: editors keep the previous js, cannot change it", async () => {
    const { ctx: editorCtx } = await t.createUserCtx([DefaultRole.Editor]);
    const saved = await partialSave.run({ name: "ds.hero", liquid: HERO, liquidEdit: HERO_EDIT }, editorCtx);
    expect(saved.js).toContain("__hero");
    await expect(
      partialSave.run({ name: "ds.hero", liquid: HERO, js: "alert(1)" }, editorCtx),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("delivery renders blocks through {% render blk.__component %} and attaches used partial scripts", async () => {
    const res = await app.inject({ method: "GET", url: `/delivery/landing/${pageId}?format=html&embed=1&ws=${t.workspaceSlug}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.html).toContain('<h1>Hello &lt;World&gt;</h1>');
    expect(body.html).toContain("<b>NEW</b>");
    // nested partial: card → badge, default filter for the missing kind
    expect(body.html).toContain('<span class="badge">accent</span>');
    expect(body.html).toContain('<span class="badge">plain</span>');
    expect(body.html).not.toContain("data-blk"); // published render never carries edit markers
    // template js is empty; hero's js rides along once
    expect(body.js).toContain("__hero");
    expect(body.partials).toEqual([{ name: "ds.hero", version: 2, hasCss: false, hasJs: true }]);

    const frag = await app.inject({ method: "GET", url: `/delivery/landing/${pageId}?format=html&ws=${t.workspaceSlug}` });
    expect(frag.body).toContain('<script defer src="/delivery/templates/partials/ds.hero/v2/script.js"></script>');

    const js = await app.inject({ method: "GET", url: `/delivery/templates/partials/ds.hero/v2/script.js?ws=${t.workspaceSlug}` });
    expect(js.statusCode).toBe(200);
    expect(js.headers["content-type"]).toContain("javascript");
    expect(js.body).toContain("__hero");
    expect((await app.inject({ method: "GET", url: `/delivery/templates/partials/ds.hero/v9/script.js?ws=${t.workspaceSlug}` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/delivery/templates/partials/ds.hero/vNaN/script.js?ws=${t.workspaceSlug}` })).statusCode).toBe(404);
  });

  it("partial render: block value becomes blk; unsaved source renders; nested partials resolve", async () => {
    const out = await partialRender.run({ name: "ds.card", values: { title: "Solo", kind: "k" } }, t.ctx);
    expect(out.html).toBe('<article class="card"><h3>Solo</h3><span class="badge">k</span><!-- v2 --></article>');
    const unsaved = await partialRender.run({ name: "ds.card", values: { title: "X" }, liquid: "<p>{{ blk.title }}</p>" }, t.ctx);
    expect(unsaved.html).toBe("<p>X</p>");
    await expect(partialRender.run({ name: "ds.missing", values: {} }, t.ctx)).rejects.toThrow(/not found/);
  });

  it("a partial that renders itself fails fast; an unknown partial name is a render error", async () => {
    await partialSave.run({ name: "loop", liquid: "x{% render 'loop' %}" }, t.ctx);
    await expect(partialRender.run({ name: "loop", values: {} }, t.ctx)).rejects.toThrow(/limit exceeded/);
    await expect(
      partialRender.run({ name: "ds.card", values: {}, liquid: "{% render 'nope.partial' %}" }, t.ctx),
    ).rejects.toThrow(/Unknown partial 'nope.partial'/);
  });
});

describe("C2 — preview with unsaved values and edit markers", () => {
  it("edit: true renders the marked variants with the block ids; the default render has no markers", async () => {
    const plain = await templateRenderPreview.run({ typeUid: "landing", entryId: pageId }, t.ctx);
    expect(plain.html).not.toContain("data-blk");

    const edit = await templateRenderPreview.run({ typeUid: "landing", entryId: pageId, edit: true }, t.ctx);
    expect(edit.html).toMatch(/data-blk="[A-Za-z0-9-]{8}"/);
    expect(edit.html).toContain('data-prop="title"');
    // partials without an edit variant fall back to their published source
    expect(edit.html).toContain('<article class="card">');
  });

  it("values: renders an unsaved tree in place of the entry and assigns ids to new blocks", async () => {
    const out = await templateRenderPreview.run(
      {
        typeUid: "landing",
        entryId: pageId,
        edit: true,
        values: { title: "draft", sections: [{ __component: "ds.hero", title: "Unsaved hero" }] },
      },
      t.ctx,
    );
    expect(out.html).toContain("Unsaved hero");
    expect(out.html).not.toContain("Card A");
    expect(out.html).toMatch(/data-blk="[A-Za-z0-9-]{8}"/);
  });
});

describe("C4 — single-type text fields as files", () => {
  let assetsLocale: string;
  beforeAll(async () => {
    await contentTypeCreate.run(
      {
        uid: "site_assets",
        name: "Site assets",
        kind: ContentTypeKind.Single,
        definition: {
          fields: [
            { name: "common_css", type: "text", multiline: true },
            { name: "tokens", type: "json" },
            { name: "count", type: "number" },
          ],
        },
      },
      t.ctx,
    );
    const e = await entryCreate.run(
      { typeUid: "site_assets", values: { common_css: ":root{--x:1}", tokens: { a: 1 }, count: 3 } },
      t.ctx,
    );
    assetsLocale = e.entry.locale;
    // draft first — must be invisible without a token
    const draftRes = await app.inject({ method: "GET", url: `/delivery/site_assets/common_css.css?ws=${t.workspaceSlug}` });
    expect(draftRes.statusCode).toBe(404);
    await publishEntry(t.ctx, "site_assets", e.entry.id);
  });

  it("serves css/json with the right content type, an ETag and 304 on revalidation", async () => {
    const css = await app.inject({ method: "GET", url: `/delivery/site_assets/common_css.css?ws=${t.workspaceSlug}` });
    expect(css.statusCode).toBe(200);
    expect(css.headers["content-type"]).toContain("text/css");
    expect(css.body).toBe(":root{--x:1}");
    expect(css.headers["cache-control"]).toContain("public");
    const etag = css.headers.etag as string;
    expect(etag).toMatch(/^W\//);

    const again = await app.inject({
      method: "GET",
      url: `/delivery/site_assets/common_css.css?ws=${t.workspaceSlug}&locale=${assetsLocale}`,
      headers: { "if-none-match": etag },
    });
    expect(again.statusCode).toBe(304);

    const json = await app.inject({ method: "GET", url: `/delivery/site_assets/tokens.json?ws=${t.workspaceSlug}` });
    expect(json.statusCode).toBe(200);
    expect(json.headers["content-type"]).toContain("application/json");
    expect(JSON.parse(json.body)).toEqual({ a: 1 });
  });

  it("refuses non-text fields, unknown fields, unsupported extensions and collection types", async () => {
    const q = `?ws=${t.workspaceSlug}`;
    expect((await app.inject({ method: "GET", url: `/delivery/site_assets/count.css${q}` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/delivery/site_assets/nope.css${q}` })).statusCode).toBe(404);
    // unknown extension does not match the file pattern → falls through to the uuid check (400)
    expect((await app.inject({ method: "GET", url: `/delivery/site_assets/common_css.exe${q}` })).statusCode).toBe(400);
    // collection types are not served this way
    expect((await app.inject({ method: "GET", url: `/delivery/landing/title.css${q}` })).statusCode).toBe(404);
    // entry ids still work next to the file route
    expect((await app.inject({ method: "GET", url: `/delivery/landing/${pageId}${q}` })).statusCode).toBe(200);
  });
});

describe("C5 — reserved uid and token scopes", () => {
  it("'partials' cannot become a content type uid (static route would shadow it)", async () => {
    await expect(
      contentTypeCreate.run({ uid: "partials", name: "x", definition: { fields: [{ name: "a", type: "text" }] } }, t.ctx),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("partial routes sit in the templates scope; render is a read", () => {
    expect(requiredScopeFor("GET", "/api/templates/partials")).toMatchObject({ scope: "templates", level: "read" });
    expect(requiredScopeFor("PUT", "/api/templates/partials/ds.hero")).toMatchObject({ scope: "templates", level: "edit" });
    expect(requiredScopeFor("POST", "/api/templates/partials/ds.hero/render")).toMatchObject({ scope: "templates", level: "read" });
    expect(requiredScopeFor("DELETE", "/api/templates/partials/ds.hero")).toMatchObject({ scope: "templates", level: "edit" });
  });
});

describe("40-IMPL — component markup (toggle, css, versions)", () => {
  const STAT = `<div class="stat"><b>{{ blk.value }}</b><span>{{ blk.label | escape }}</span></div>`;
  const STAT_CSS = `.stat { display: grid } .stat b { font-size: 2rem }`;
  let statPageId: string;

  beforeAll(async () => {
    await componentCreate.run(
      { uid: "ds.stat", name: "Stat", definition: { fields: [{ name: "value", type: "number" }, { name: "label", type: "text" }] } },
      t.ctx,
    );
    await contentTypeCreate.run(
      {
        uid: "stats_page",
        name: "Stats page",
        definition: {
          fields: [
            { name: "title", type: "text", required: true },
            { name: "sections", type: "dynamic_zone", components: ["ds.stat", "ds.hero"] },
          ],
          displayField: "title",
        },
      },
      t.ctx,
    );
    await templateSave.run({ typeUid: "stats_page", liquid: PAGE_LIQUID, css: ".page { margin: 0 }" }, t.ctx);
    const page = await entryCreate.run(
      {
        typeUid: "stats_page",
        values: { title: "Stats", sections: [{ __component: "ds.stat", value: 42, label: "Robots" }, { __component: "ds.hero", title: "H" }] },
      },
      t.ctx,
    );
    statPageId = page.entry.id;
    await publishEntry(t.ctx, "stats_page", statPageId);
  });

  it("a component is created with markup off; saving its partial is 409 until the toggle is on", async () => {
    const before = (await componentList.run({}, t.ctx)).find((c) => c.uid === "ds.stat")!;
    expect(before.options).toEqual({});
    expect(before.markup).toBeNull();
    expect(before.markupEnabled).toBe(false);
    const err = await partialSave.run({ name: "ds.stat", liquid: STAT }, t.ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ComponentMarkupDisabledError);
    expect((err as ComponentMarkupDisabledError).statusCode).toBe(409);
    expect((err as ComponentMarkupDisabledError).code).toBe("COMPONENT_MARKUP_DISABLED");

    const on = await componentUpdate.run({ uid: "ds.stat", options: { markup: true } }, t.ctx);
    expect(on.options).toEqual({ markup: true });
    const saved = await partialSave.run({ name: "ds.stat", liquid: STAT, css: STAT_CSS }, t.ctx);
    expect(saved.version).toBe(1);
    expect(saved.css).toBe(STAT_CSS);

    const after = (await componentList.run({}, t.ctx)).find((c) => c.uid === "ds.stat")!;
    expect(after.markup).toMatchObject({ version: 1, hasCss: true, hasJs: false });
    const got = await partialGet.run({ name: "ds.stat" }, t.ctx);
    expect(got.current?.css).toBe(STAT_CSS);
    const listed = (await partialList.run({}, t.ctx)).find((p) => p.name === "ds.stat")!;
    expect(listed).toMatchObject({ hasCss: true, hasJs: false, component: true, enabled: true });
    // a free-named partial is not a component
    expect((await partialList.run({}, t.ctx)).find((p) => p.name === "ds.badge")).toMatchObject({ component: false, enabled: true });
  });

  it("legacy: a component whose options never had the key counts as on when its partial already exists", async () => {
    await componentCreate.run({ uid: "ds.legacy", name: "Legacy", definition: { fields: [{ name: "title", type: "text" }] } }, t.ctx);
    // the partial was published before the toggle existed — write the row the way core 0.5.17 did
    await t.db.insert(templatePartials).values({ workspaceId: t.ctx.workspaceId, name: "ds.legacy", version: 1, liquid: "<em>{{ blk.title }}</em>", isCurrent: true });
    const listed = (await componentList.run({}, t.ctx)).find((c) => c.uid === "ds.legacy")!;
    expect(listed.options).toEqual({});
    expect(listed.markupEnabled).toBe(true);
    // renders, and saves a new version without touching the toggle
    expect((await partialRender.run({ name: "ds.legacy", values: { title: "L" } }, t.ctx)).html).toBe("<em>L</em>");
    expect((await partialSave.run({ name: "ds.legacy", liquid: "<em>2</em>" }, t.ctx)).version).toBe(2);
    expect((await partialList.run({}, t.ctx)).find((p) => p.name === "ds.legacy")).toMatchObject({ component: true, enabled: true });
    // an explicit off still wins
    await componentUpdate.run({ uid: "ds.legacy", options: { markup: false } }, t.ctx);
    expect((await componentList.run({}, t.ctx)).find((c) => c.uid === "ds.legacy")!.markupEnabled).toBe(false);
    await expect(partialSave.run({ name: "ds.legacy", liquid: "x" }, t.ctx)).rejects.toBeInstanceOf(ComponentMarkupDisabledError);
  });

  it("the toggle refuses a uid the partial grammar cannot name", async () => {
    await componentCreate.run({ uid: "odd..name", name: "Odd", definition: { fields: [] } }, t.ctx);
    await expect(componentUpdate.run({ uid: "odd..name", options: { markup: true } }, t.ctx)).rejects.toBeInstanceOf(ValidationError);
  });

  it("delivery links the used component's style.css, inlines it in embed css, and serves it version-pinned", async () => {
    const frag = await app.inject({ method: "GET", url: `/delivery/stats_page/${statPageId}?format=html&ws=${t.workspaceSlug}` });
    expect(frag.statusCode).toBe(200);
    expect(frag.body).toContain('<link rel="stylesheet" href="/delivery/templates/partials/ds.stat/v1/style.css">');
    expect(frag.body).not.toContain("partials/ds.stat/v1/script.js"); // no js → no script tag
    expect(frag.body).toContain("partials/ds.hero/v2/script.js");

    const embed = (await app.inject({ method: "GET", url: `/delivery/stats_page/${statPageId}?format=html&embed=1&ws=${t.workspaceSlug}` })).json();
    expect(embed.css).toContain(".page { margin: 0 }");
    expect(embed.css).toContain("/* partial ds.stat v1 */");
    expect(embed.css).toContain(STAT_CSS);
    expect(embed.partials).toEqual([
      { name: "ds.hero", version: 2, hasCss: false, hasJs: true },
      { name: "ds.stat", version: 1, hasCss: true, hasJs: false },
    ]);

    const css = await app.inject({ method: "GET", url: `/delivery/templates/partials/ds.stat/v1/style.css?ws=${t.workspaceSlug}` });
    expect(css.statusCode).toBe(200);
    expect(css.headers["content-type"]).toContain("text/css");
    expect(css.headers["cache-control"]).toContain("immutable");
    expect(css.body).toBe(STAT_CSS);
    expect((await app.inject({ method: "GET", url: `/delivery/templates/partials/ds.stat/v3/style.css?ws=${t.workspaceSlug}` })).statusCode).toBe(404);
  });

  it("type preview and partial render carry the component css", async () => {
    const preview = await templateRenderPreview.run({ typeUid: "stats_page", entryId: statPageId }, t.ctx);
    expect(preview.html).toContain("<b>42</b>");
    expect(preview.css).toContain(".page { margin: 0 }");
    expect(preview.css).toContain(STAT_CSS);

    const own = await partialRender.run({ name: "ds.stat", values: { value: 1, label: "x" } }, t.ctx);
    expect(own.css).toBe(STAT_CSS);
    const unsaved = await partialRender.run({ name: "ds.stat", values: {}, liquid: "<i>u</i>", css: ".u{}" }, t.ctx);
    expect(unsaved).toEqual({ html: "<i>u</i>", css: ".u{}" });
    // nested: card → badge; the card has no css of its own, badge neither → empty
    expect((await partialRender.run({ name: "ds.card", values: { title: "n" } }, t.ctx)).css).toBe("");
  });

  it("css is kept across a save that omits it; a saved version can be made current again", async () => {
    const v2 = await partialSave.run({ name: "ds.stat", liquid: STAT + "<!-- v2 -->" }, t.ctx);
    expect(v2.version).toBe(2);
    expect(v2.css).toBe(STAT_CSS);
    const back = await partialSetCurrent.run({ name: "ds.stat", version: 1 }, t.ctx);
    expect(back.version).toBe(1);
    expect((await partialGet.run({ name: "ds.stat" }, t.ctx)).current?.version).toBe(1);
    await expect(partialSetCurrent.run({ name: "ds.stat", version: 9 }, t.ctx)).rejects.toThrow(/not found/);
    const res = await app.inject({ method: "POST", url: `/api/templates/partials/ds.stat/versions/2/activate` });
    expect(res.statusCode).toBe(401); // route exists; this bare call has no session
  });

  it("turning markup off hides the partial from renders — the page fails visibly, versions survive", async () => {
    await componentUpdate.run({ uid: "ds.stat", options: { markup: false } }, t.ctx);
    const res = await app.inject({ method: "GET", url: `/delivery/stats_page/${statPageId}?format=html&ws=${t.workspaceSlug}` });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.body).toContain("ds.stat");
    expect((await partialList.run({}, t.ctx)).find((p) => p.name === "ds.stat")).toMatchObject({ component: true, enabled: false });
    await expect(partialSave.run({ name: "ds.stat", liquid: STAT }, t.ctx)).rejects.toBeInstanceOf(ComponentMarkupDisabledError);
    await expect(partialSetCurrent.run({ name: "ds.stat", version: 2 }, t.ctx)).rejects.toBeInstanceOf(ComponentMarkupDisabledError);

    await componentUpdate.run({ uid: "ds.stat", options: { markup: true } }, t.ctx);
    const ok = await app.inject({ method: "GET", url: `/delivery/stats_page/${statPageId}?format=html&ws=${t.workspaceSlug}` });
    expect(ok.statusCode).toBe(200);
    expect((await partialGet.run({ name: "ds.stat" }, t.ctx)).versions.length).toBe(2);
  });

  it("scopes: activate is an edit on templates; style.css is public delivery", async () => {
    expect(requiredScopeFor("POST", "/api/templates/partials/ds.stat/versions/1/activate")).toMatchObject({ scope: "templates", level: "edit" });
    expect(requiredScopeFor("PUT", "/api/components/ds.stat")).toMatchObject({ scope: "schema", level: "edit" });
  });
});
