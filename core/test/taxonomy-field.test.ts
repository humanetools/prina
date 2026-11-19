/** Taxonomy field type (44-IMPL): definition, write validation (top-level and inside blocks), populate subtree, GraphQL */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createDb } from "../src/db/client.js";
import { contentTypeCreate } from "../src/modules/content-type/commands.js";
import { componentCreate } from "../src/modules/content-type/component-commands.js";
import { entryCreate, entryUpdate } from "../src/modules/entry/commands.js";
import { taxonomyCreate, taxonomyNodeCreate } from "../src/modules/taxonomy/commands.js";
import { populateValuesList } from "../src/modules/delivery/populate.js";
import { partialRender, partialSave } from "../src/modules/template/partial-commands.js";
import { templateRenderPreview } from "../src/modules/template/commands.js";
import type { DeliveryCtx } from "../src/modules/delivery/service.js";
import { resetGraphqlSchemaCache } from "../src/modules/graphql/execute.js";
import { publishEntry, setupTestContext, type TestContext } from "./helpers.js";

let t: TestContext;
let app: FastifyInstance;
let ws: string;
const nodes = { main: "", mv: "", areaScan: "", lineScan: "", agv: "", other: "" };
let pageId = "";

const get = (url: string) => app.inject({ method: "GET", url: `${url}${url.includes("?") ? "&" : "?"}ws=${ws}` });

beforeAll(async () => {
  t = await setupTestContext();
  ws = t.workspaceSlug;
  resetGraphqlSchemaCache();
  const { db } = createDb(process.env.TEST_DATABASE_URL!);
  app = buildApp({ env: { LOG_LEVEL: "error", NODE_ENV: "test", ADMIN_DIST_PATH: undefined, S3_REGION: "us-east-1" }, db, services: t.services });

  await taxonomyCreate.run({ uid: "tf_gnb", name: "GNB" }, t.ctx);
  await taxonomyCreate.run({ uid: "tf_other", name: "Other" }, t.ctx);
  const node = async (taxonomyUid: string, name: string, slug: string, parentId: string | null = null, position = 0) =>
    (await taxonomyNodeCreate.run({ taxonomyUid, name, slug, parentId, position }, t.ctx)).id;
  nodes.main = await node("tf_gnb", "Main", "main");
  nodes.mv = await node("tf_gnb", "Machine Vision", "mv", nodes.main, 0);
  nodes.areaScan = await node("tf_gnb", "Area scan camera", "area-scan", nodes.mv, 1);
  nodes.lineScan = await node("tf_gnb", "Line scan camera", "line-scan", nodes.mv, 0);
  nodes.agv = await node("tf_gnb", "AGV", "agv", nodes.main, 1);
  nodes.other = await node("tf_other", "Elsewhere", "elsewhere");

  // menu block = component with a taxonomy field (depth 2), page = type with a single taxonomy field + a zone of menu blocks
  await componentCreate.run(
    { uid: "tf.menu", name: "Menu", options: { markup: true }, definition: { fields: [
      { name: "root", type: "taxonomy", taxonomy: "tf_gnb", depth: 2 },
      { name: "pins", type: "taxonomy", taxonomy: "tf_gnb", multiple: true },
    ] } },
    t.ctx,
  );
  await contentTypeCreate.run(
    { uid: "tf_page", name: "Page", definition: { displayField: "title", fields: [
      { name: "title", type: "text", required: true },
      { name: "section", type: "taxonomy", taxonomy: "tf_gnb" },
      { name: "blocks", type: "dynamic_zone", components: ["tf.menu"] },
    ] } },
    t.ctx,
  );
  const { entry } = await entryCreate.run(
    { typeUid: "tf_page", values: {
      title: "Home",
      section: nodes.mv,
      blocks: [{ __component: "tf.menu", root: nodes.main, pins: [nodes.agv, nodes.areaScan] }],
    } },
    t.ctx,
  );
  pageId = entry.id;
  await publishEntry(t.ctx, "tf_page", pageId);
});
afterAll(async () => {
  await app.close();
  await t.cleanup();
});

describe("taxonomy field — definition", () => {
  it("rejects a definition without a taxonomy uid and a depth above the cap", async () => {
    await expect(
      contentTypeCreate.run({ uid: "tf_bad1", name: "Bad", definition: { fields: [{ name: "x", type: "taxonomy" }] } }, t.ctx),
    ).rejects.toThrow();
    await expect(
      contentTypeCreate.run({ uid: "tf_bad2", name: "Bad", definition: { fields: [{ name: "x", type: "taxonomy", taxonomy: "tf_gnb", depth: 9 }] } }, t.ctx),
    ).rejects.toThrow();
  });
});

describe("taxonomy field — write validation", () => {
  it("rejects a node of another taxonomy at the top level", async () => {
    await expect(
      entryCreate.run({ typeUid: "tf_page", values: { title: "Bad", section: nodes.other } }, t.ctx),
    ).rejects.toMatchObject({ details: { issues: [expect.stringContaining("section: node " + nodes.other + " does not exist in taxonomy 'tf_gnb'")] } });
  });
  it("rejects a dangling node inside a dynamic-zone block", async () => {
    await expect(
      entryCreate.run(
        { typeUid: "tf_page", values: { title: "Bad", blocks: [{ __component: "tf.menu", root: "00000000-0000-0000-0000-000000000000" }] } },
        t.ctx,
      ),
    ).rejects.toMatchObject({ details: { issues: [expect.stringContaining("root: node 00000000-0000-0000-0000-000000000000 does not exist in taxonomy 'tf_gnb'")] } });
  });
  it("rejects a non-uuid and a scalar where multiple is expected (schema)", async () => {
    await expect(entryCreate.run({ typeUid: "tf_page", values: { title: "Bad", section: "not-a-uuid" } }, t.ctx)).rejects.toThrow();
    await expect(
      entryCreate.run({ typeUid: "tf_page", values: { title: "Bad", blocks: [{ __component: "tf.menu", pins: nodes.agv }] } }, t.ctx),
    ).rejects.toThrow();
  });
  it("accepts null / empty and a valid update", async () => {
    const { entry } = await entryCreate.run({ typeUid: "tf_page", values: { title: "Empty", section: null, blocks: [] } }, t.ctx);
    await entryUpdate.run({ typeUid: "tf_page", id: entry.id, values: { section: nodes.agv } }, t.ctx);
  });
});

describe("taxonomy field — populate", () => {
  it("raw delivery keeps ids; populate=1 inlines the node with its subtree to `depth`", async () => {
    const raw = await get(`/delivery/tf_page/${pageId}`);
    expect(raw.statusCode).toBe(200);
    expect(raw.json().values.section).toBe(nodes.mv);

    const res = await get(`/delivery/tf_page/${pageId}?populate=1`);
    expect(res.statusCode).toBe(200);
    const v = res.json().values;
    // single, depth 0 → node only, no children
    expect(v.section).toMatchObject({ id: nodes.mv, taxonomy: "tf_gnb", name: "Machine Vision", slug: "mv", path: "main.mv", depth: 1, children: [] });
    // block: depth 2 → main > [mv > [line-scan, area-scan] (position order), agv]
    const root = v.blocks[0].root;
    expect(root.id).toBe(nodes.main);
    expect(root.children.map((c: { slug: string }) => c.slug)).toEqual(["mv", "agv"]);
    expect(root.children[0].children.map((c: { slug: string }) => c.slug)).toEqual(["line-scan", "area-scan"]);
    expect(root.children[0].children.map((c: { path: string }) => c.path)).toEqual(["main.mv.line_scan", "main.mv.area_scan"]);
    expect(root.children[0].children[0].children).toEqual([]);
    // multiple → array in stored order, depth 0
    expect(v.blocks[0].pins.map((p: { id: string }) => p.id)).toEqual([nodes.agv, nodes.areaScan]);
    expect(v.blocks[0].pins[1]).toMatchObject({ path: "main.mv.area_scan", depth: 2, children: [] });
  });

  it("a deleted node drops out: singular → null, array shrinks", async () => {
    const dctx: DeliveryCtx = { db: t.db, services: t.ctx.services, workspace: { id: t.ctx.workspaceId, slug: ws, settings: {} }, includeDraft: true };
    const def = { fields: [
      { name: "one", type: "taxonomy", taxonomy: "tf_gnb" },
      { name: "many", type: "taxonomy", taxonomy: "tf_gnb", multiple: true },
    ] };
    const gone = "11111111-1111-1111-1111-111111111111";
    const [p] = await populateValuesList(dctx, def as never, [{ one: gone, many: [nodes.agv, gone] }]);
    expect(p!.one).toBeNull();
    expect((p!.many as Array<{ id: string }>).map((n) => n.id)).toEqual([nodes.agv]);
  });
});

describe("taxonomy field — GraphQL", () => {
  it("exposes TaxonomyNodeRef with nested children (entry roots are camelCase, blocks are Component<Pascal>)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/delivery/graphql?ws=${ws}`,
      payload: { query: `{ tfPage(id: "${pageId}") { section { name path children { name } } blocks { ... on ComponentTfMenu { root { slug children { slug children { slug } } } pins { slug } } } } }` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.errors).toBeUndefined();
    const v = body.data.tfPage;
    expect(v.section).toEqual({ name: "Machine Vision", path: "main.mv", children: [] });
    expect(v.blocks[0].root.children.map((c: { slug: string }) => c.slug)).toEqual(["mv", "agv"]);
    expect(v.blocks[0].root.children[0].children.map((c: { slug: string }) => c.slug)).toEqual(["line-scan", "area-scan"]);
    expect(v.blocks[0].pins.map((p: { slug: string }) => p.slug)).toEqual(["agv", "area-scan"]);
  });
});

describe("taxonomy field — block markup preview (partial render with populate)", () => {
  it("resolves the block's taxonomy value so the partial can loop over children", async () => {
    await partialSave.run(
      { name: "tf.menu", liquid: '<nav>{% for item in blk.root.children %}<a href="/{{ item.slug }}">{{ item.name }}</a>{% endfor %}</nav>' },
      t.ctx,
    );
    const raw = await partialRender.run({ name: "tf.menu", values: { root: nodes.main } }, t.ctx);
    expect(raw.html).toBe("<nav></nav>"); // id only — nothing to loop over
    const populated = await partialRender.run({ name: "tf.menu", values: { root: nodes.main }, populate: true }, t.ctx);
    expect(populated.html).toBe('<nav><a href="/mv">Machine Vision</a><a href="/agv">AGV</a></nav>');
  });
});

describe("whole-entry preview before save (create screen)", () => {
  it("renders unsaved values without an entryId, populated like delivery", async () => {
    const out = await templateRenderPreview.run(
      { typeUid: "tf_page", values: { title: "Draft page", section: nodes.mv }, populate: true, liquid: "{{ values.title }}|{{ values.section.name }}|{{ entry.status }}" },
      t.ctx,
    );
    expect(out.html).toBe("Draft page|Machine Vision|draft");
    await expect(templateRenderPreview.run({ typeUid: "tf_page", liquid: "x" }, t.ctx)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});
