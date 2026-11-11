/** Taxonomy on the delivery plane (22-IMPL-delivery-taxonomy): tree, list filter, entry taxonomies, GraphQL */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createDb } from "../src/db/client.js";
import { contentTypeCreate } from "../src/modules/content-type/commands.js";
import { componentCreate } from "../src/modules/content-type/component-commands.js";
import { entryCreate } from "../src/modules/entry/commands.js";
import { entrySetTaxonomies } from "../src/modules/entry/document-commands.js";
import { taxonomyCreate, taxonomyNodeCreate } from "../src/modules/taxonomy/commands.js";
import { issueDraftToken } from "../src/modules/delivery/token.js";
import { resetGraphqlSchemaCache } from "../src/modules/graphql/execute.js";
import { publishEntry, setupTestContext, type TestContext } from "./helpers.js";

let t: TestContext;
let app: FastifyInstance;
let ws: string;
const ids = { charger: "", caseItem: "", phone: "", draftCharger: "", brand: "" };
const nodes = { accessories: "", chargers: "", cases: "", phones: "", launch: "" };

const get = (url: string) => app.inject({ method: "GET", url: `${url}${url.includes("?") ? "&" : "?"}ws=${ws}` });
const titles = (res: { json(): { items: Array<{ values: { title: string } }> } }) => res.json().items.map((i) => i.values.title).sort();

beforeAll(async () => {
  t = await setupTestContext();
  ws = t.workspaceSlug;
  resetGraphqlSchemaCache();
  const { db } = createDb(process.env.TEST_DATABASE_URL!);
  app = buildApp({ env: { LOG_LEVEL: "error", NODE_ENV: "test", ADMIN_DIST_PATH: undefined, S3_REGION: "us-east-1" }, db, services: t.services });

  await contentTypeCreate.run({ uid: "tx_brand", name: "Brand", definition: { fields: [{ name: "title", type: "text", required: true }], displayField: "title" } }, t.ctx);
  await contentTypeCreate.run({ uid: "tx_item", name: "Item", definition: { fields: [{ name: "title", type: "text", required: true }], displayField: "title" } }, t.ctx);
  await componentCreate.run(
    { uid: "tx_charger_attrs", name: "Charger attrs", definition: { fields: [{ name: "wattage", type: "number" }, { name: "made_by", type: "relation", target: "tx_brand", relationKind: "manyToOne" }] } },
    t.ctx,
  );
  await taxonomyCreate.run({ uid: "tx_shop", name: "Shop" }, t.ctx);
  await taxonomyCreate.run({ uid: "tx_campaign", name: "Campaign" }, t.ctx);
  const node = async (taxonomyUid: string, name: string, slug: string, parentId: string | null = null, entryComponentUid: string | null = null) =>
    (await taxonomyNodeCreate.run({ taxonomyUid, name, slug, parentId, entryComponentUid }, t.ctx)).id;
  nodes.accessories = await node("tx_shop", "Accessories", "accessories");
  nodes.chargers = await node("tx_shop", "Chargers", "fast-chargers", nodes.accessories, "tx_charger_attrs");
  nodes.cases = await node("tx_shop", "Cases", "cases", nodes.accessories);
  nodes.phones = await node("tx_shop", "Phones", "phones");
  nodes.launch = await node("tx_campaign", "Launch", "launch");

  const make = async (typeUid: string, title: string, publish = true) => {
    const { entry } = await entryCreate.run({ typeUid, values: { title } }, t.ctx);
    if (publish) await publishEntry(t.ctx, typeUid, entry.id);
    return entry.id;
  };
  ids.brand = await make("tx_brand", "Acme");
  ids.charger = await make("tx_item", "Charger 45W");
  ids.caseItem = await make("tx_item", "Clear case");
  ids.phone = await make("tx_item", "Phone X");
  ids.draftCharger = await make("tx_item", "Charger prototype", false);

  const attach = (id: string, attachments: Array<{ nodeId: string; entryComponentValues?: Record<string, unknown> }>) =>
    entrySetTaxonomies.run({ typeUid: "tx_item", id, attachments }, t.ctx);
  await attach(ids.charger, [{ nodeId: nodes.chargers, entryComponentValues: { wattage: 45, made_by: ids.brand } }, { nodeId: nodes.launch }]);
  await attach(ids.caseItem, [{ nodeId: nodes.cases }]);
  await attach(ids.phone, [{ nodeId: nodes.phones }, { nodeId: nodes.launch }]);
  await attach(ids.draftCharger, [{ nodeId: nodes.chargers, entryComponentValues: { wattage: 100 } }]);
});
afterAll(async () => {
  await app.close();
  await t.cleanup();
});

describe("delivery taxonomy — tree", () => {
  it("lists taxonomies and returns a path-ordered flat tree with parents first", async () => {
    const list = await get("/delivery/taxonomies");
    expect(list.statusCode).toBe(200);
    expect(list.json().items.map((x: { uid: string }) => x.uid)).toEqual(expect.arrayContaining(["tx_shop", "tx_campaign"]));

    const tree = (await get("/delivery/taxonomies/tx_shop")).json();
    expect(tree.nodes.map((n: { path: string }) => n.path)).toEqual(["accessories", "accessories.cases", "accessories.fast_chargers", "phones"]);
    const chargers = tree.nodes.find((n: { slug: string }) => n.slug === "fast-chargers");
    expect(chargers).toMatchObject({ parentId: nodes.accessories, depth: 1, entryComponent: "tx_charger_attrs" });
    expect((await get("/delivery/taxonomies/nope_nothing")).statusCode).toBe(404);
    expect((await get("/delivery/taxonomies/Bad%20Uid")).statusCode).toBe(404);
  });
});

describe("delivery taxonomy — list filter", () => {
  it("includes descendants by default, the node alone with taxonomyExact=1, ANDs several filters", async () => {
    expect(titles(await get("/delivery/tx_item?taxonomy=tx_shop:accessories"))).toEqual(["Charger 45W", "Clear case"]);
    expect(titles(await get("/delivery/tx_item?taxonomy=tx_shop:accessories&taxonomyExact=1"))).toEqual([]);
    // the slug spelling (hyphen) addresses the same node as the path label
    expect(titles(await get("/delivery/tx_item?taxonomy=tx_shop:accessories.fast-chargers"))).toEqual(["Charger 45W"]);
    expect(titles(await get("/delivery/tx_item?taxonomy=tx_shop:accessories.fast_chargers"))).toEqual(["Charger 45W"]);
    expect(titles(await get("/delivery/tx_item?taxonomy=tx_campaign:launch"))).toEqual(["Charger 45W", "Phone X"]);
    expect(titles(await get("/delivery/tx_item?taxonomy=tx_campaign:launch&taxonomy=tx_shop:phones"))).toEqual(["Phone X"]);
    const res = await get("/delivery/tx_item?taxonomy=tx_shop:accessories");
    expect(res.headers["x-total-count"]).toBe("2"); // totals follow the filter
  });

  it("drafts stay out without a draft token and come in with one", async () => {
    expect(titles(await get("/delivery/tx_item?taxonomy=tx_shop:accessories.fast-chargers"))).not.toContain("Charger prototype");
    const { token } = await issueDraftToken(t.ctx.db, ws, 1);
    expect(titles(await get(`/delivery/tx_item?taxonomy=tx_shop:accessories.fast-chargers&draft=${token}`))).toContain("Charger prototype");
  });

  it("unknown taxonomy / node → 404, malformed input → 422, never 500", async () => {
    expect((await get("/delivery/tx_item?taxonomy=tx_shop:no.such.node")).statusCode).toBe(404);
    expect((await get("/delivery/tx_item?taxonomy=zz_missing:accessories")).statusCode).toBe(404);
    const malformed = ["nocolon", ":x", "tx_shop:", "tx_shop:a..b", "tx_shop:a';DROP TABLE entries;--", "TX_SHOP:accessories", `tx_shop:${"a".repeat(3000)}`, `tx_shop:${Array(40).fill("a").join(".")}`];
    for (const value of malformed) {
      const res = await get(`/delivery/tx_item?taxonomy=${encodeURIComponent(value)}`);
      expect(res.statusCode, value.slice(0, 40)).toBe(422);
    }
    const many = Array.from({ length: 9 }, () => "taxonomy=tx_shop:phones").join("&");
    expect((await get(`/delivery/tx_item?${many}`)).statusCode).toBe(422);
  });
});

describe("delivery taxonomy — on the entry", () => {
  it("is opt-in; attribute values come back stored, and resolved with populate=1", async () => {
    const plain = (await get(`/delivery/tx_item/${ids.charger}`)).json();
    expect(plain.taxonomies).toBeUndefined();

    const one = (await get(`/delivery/tx_item/${ids.charger}?taxonomies=1`)).json();
    expect(one.taxonomies.map((x: { taxonomy: string; path: string }) => `${x.taxonomy}:${x.path}`)).toEqual(["tx_campaign:launch", "tx_shop:accessories.fast_chargers"]);
    const chargers = one.taxonomies.find((x: { path: string }) => x.path === "accessories.fast_chargers");
    expect(chargers).toMatchObject({ name: "Chargers", slug: "fast-chargers", entryComponent: "tx_charger_attrs", entryComponentValues: { wattage: 45, made_by: ids.brand } });
    expect(one.taxonomies.find((x: { path: string }) => x.path === "launch").entryComponentValues).toBeNull();

    const populated = (await get(`/delivery/tx_item/${ids.charger}?taxonomies=1&populate=1`)).json();
    const attrs = populated.taxonomies.find((x: { path: string }) => x.path === "accessories.fast_chargers").entryComponentValues;
    expect(attrs.wattage).toBe(45);
    expect(attrs.made_by).toMatchObject({ id: ids.brand, type: "tx_brand" });

    const list = (await get("/delivery/tx_item?taxonomies=1&taxonomy=tx_shop:accessories")).json();
    expect(list.items.every((i: { taxonomies: unknown[] }) => Array.isArray(i.taxonomies) && i.taxonomies.length > 0)).toBe(true);
    expect((await get("/delivery/tx_item")).json().items[0].taxonomies).toBeUndefined();
  });
});

describe("delivery taxonomy — GraphQL", () => {
  const gql = async (query: string) => {
    const res = await app.inject({ method: "POST", url: `/delivery/graphql?ws=${ws}`, payload: { query } });
    return res.json() as { data?: Record<string, never>; errors?: Array<{ message: string }> };
  };

  it("filters lists, exposes entry taxonomies with entryComponentValues, and serves the trees", async () => {
    const q = await gql(`{
      txItems(taxonomy: ["tx_shop:accessories"], orderBy: [{ field: title, dir: ASC }]) {
        total items { title taxonomies { taxonomy path name entryComponent entryComponentValues } }
      }
      exact: txItems(taxonomy: ["tx_shop:accessories"], taxonomyExact: true) { total }
      taxonomies { uid }
      taxonomy(uid: "tx_shop") { name nodes { path depth entryComponent } }
      missing: taxonomy(uid: "zz_missing") { name }
    }`);
    expect(q.errors?.map((e) => e.message)).toBeUndefined();
    const d = q.data as unknown as {
      txItems: { total: number; items: Array<{ title: string; taxonomies: Array<{ path: string; entryComponentValues: { wattage?: number; made_by?: { id: string } } | null }> }> };
      exact: { total: number };
      taxonomies: Array<{ uid: string }>;
      taxonomy: { name: string; nodes: Array<{ path: string }> };
      missing: null;
    };
    expect(d.txItems.total).toBe(2);
    expect(d.txItems.items.map((i) => i.title)).toEqual(["Charger 45W", "Clear case"]);
    const attrs = d.txItems.items[0]!.taxonomies.find((x) => x.path === "accessories.fast_chargers")!.entryComponentValues!;
    expect(attrs.wattage).toBe(45);
    expect(attrs.made_by).toMatchObject({ id: ids.brand }); // GraphQL always resolves
    expect(d.exact.total).toBe(0);
    expect(d.taxonomies.map((x) => x.uid)).toEqual(expect.arrayContaining(["tx_shop", "tx_campaign"]));
    expect(d.taxonomy.nodes.map((n) => n.path)).toContain("accessories.cases");
    expect(d.missing).toBeNull();

    const bad = await gql(`{ txItems(taxonomy: ["tx_shop:no.such"]) { total } }`);
    expect(bad.errors?.[0]?.message).toMatch(/not found/);
  });
});
