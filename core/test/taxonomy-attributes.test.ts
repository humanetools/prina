/** 33-IMPL — taxonomy attributes (fields on the taxonomy, values on nodes) + entry-component naming on every surface */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createDb } from "../src/db/client.js";
import { componentCreate } from "../src/modules/content-type/component-commands.js";
import { contentTypeCreate } from "../src/modules/content-type/commands.js";
import { entryCreate, entryGet } from "../src/modules/entry/commands.js";
import { entrySetTaxonomies } from "../src/modules/entry/document-commands.js";
import { resetGraphqlSchemaCache } from "../src/modules/graphql/execute.js";
import {
  taxonomyCreate,
  taxonomyList,
  taxonomyNodeCreate,
  taxonomyNodeUpdate,
  taxonomyTree,
  taxonomyUpdate,
} from "../src/modules/taxonomy/commands.js";
import { ValidationError } from "../src/lib/errors.js";
import { publishEntry, setupTestContext, type TestContext } from "./helpers.js";

let t: TestContext;
let app: FastifyInstance;
let ws: string;
let rootId: string;
let leafId: string;
let entryId: string;

beforeAll(async () => {
  t = await setupTestContext();
  ws = t.workspaceSlug;
  resetGraphqlSchemaCache();
  const { db } = createDb(process.env.TEST_DATABASE_URL!);
  app = buildApp({ env: { LOG_LEVEL: "error", NODE_ENV: "test", ADMIN_DIST_PATH: undefined, S3_REGION: "us-east-1" }, db, services: t.services });
  await contentTypeCreate.run({ uid: "ta_item", name: "Item", definition: { fields: [{ name: "title", type: "text", required: true }], displayField: "title" } }, t.ctx);
  await componentCreate.run({ uid: "ta_specs", name: "Specs", definition: { fields: [{ name: "wattage", type: "number" }] } }, t.ctx);
});
afterAll(async () => { await app.close(); await t.cleanup(); });

describe("taxonomy attributes", () => {
  it("fields are defined on the taxonomy at create or update time; names are unique snake_case", async () => {
    const created = await taxonomyCreate.run(
      { uid: "ta_shop", name: "Shop", attributeFields: [{ name: "description", type: "text", multiline: true }] },
      t.ctx,
    );
    expect(created.attributeFields).toEqual([{ name: "description", type: "text", multiline: true }]);
    const updated = await taxonomyUpdate.run(
      { uid: "ta_shop", attributeFields: [
        { name: "description", label: "Description", type: "text", multiline: true },
        { name: "erp_code", label: "ERP code", type: "text" },
        { name: "sort_order", type: "number" },
        { name: "featured", type: "boolean" },
      ] },
      t.ctx,
    );
    expect(updated.attributeFields.map((f) => f.name)).toEqual(["description", "erp_code", "sort_order", "featured"]);
    // zod issues surface as a generic ValidationError (the issue list rides in `details`)
    await expect(taxonomyUpdate.run({ uid: "ta_shop", attributeFields: [{ name: "a", type: "text" }, { name: "a", type: "number" }] }, t.ctx)).rejects.toBeInstanceOf(ValidationError);
    await expect(taxonomyUpdate.run({ uid: "ta_shop", attributeFields: [{ name: "Bad Name", type: "text" }] }, t.ctx)).rejects.toBeInstanceOf(ValidationError);
    expect((await taxonomyList.run({}, t.ctx)).find((x) => x.uid === "ta_shop")!.attributeFields).toHaveLength(4);
  });

  it("node values are validated against the fields: unknown key and wrong type are 422, null clears", async () => {
    const root = await taxonomyNodeCreate.run(
      { taxonomyUid: "ta_shop", parentId: null, name: "Accessories", slug: "accessories", attributes: { description: "All the extras", sort_order: 2, featured: true } },
      t.ctx,
    );
    rootId = root.id;
    expect(root.attributes).toEqual({ description: "All the extras", sort_order: 2, featured: true });
    await expect(
      taxonomyNodeCreate.run({ taxonomyUid: "ta_shop", parentId: null, name: "X", slug: "x", attributes: { colour: "red" } }, t.ctx),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(taxonomyNodeUpdate.run({ nodeId: rootId, attributes: { sort_order: "two" } }, t.ctx)).rejects.toThrow(/must be a number/);
    await expect(taxonomyNodeUpdate.run({ nodeId: rootId, attributes: { featured: "yes" } }, t.ctx)).rejects.toThrow(/true or false/);
    // whole-object replace: a key left out (or sent null) is gone
    const trimmed = await taxonomyNodeUpdate.run({ nodeId: rootId, attributes: { description: "Extras", featured: null, erp_code: "ACC-1" } }, t.ctx);
    expect(trimmed.attributes).toEqual({ description: "Extras", erp_code: "ACC-1" });
    // name-only edits leave attributes alone
    const renamed = await taxonomyNodeUpdate.run({ nodeId: rootId, name: "Accessories & more" }, t.ctx);
    expect(renamed.attributes).toEqual({ description: "Extras", erp_code: "ACC-1" });
  });

  it("removing a field from the taxonomy drops its values from every node", async () => {
    const leaf = await taxonomyNodeCreate.run(
      { taxonomyUid: "ta_shop", parentId: rootId, name: "Chargers", slug: "chargers", entryComponentUid: "ta_specs", attributes: { erp_code: "CHG", sort_order: 1 } },
      t.ctx,
    );
    leafId = leaf.id;
    await taxonomyUpdate.run(
      { uid: "ta_shop", attributeFields: [{ name: "description", type: "text", multiline: true }, { name: "sort_order", type: "number" }, { name: "featured", type: "boolean" }] },
      t.ctx,
    );
    const tree = await taxonomyTree.run({ taxonomyUid: "ta_shop" }, t.ctx);
    expect(tree.find((n) => n.id === rootId)!.attributes).toEqual({ description: "Extras" });
    expect(tree.find((n) => n.id === leafId)!.attributes).toEqual({ sort_order: 1 });
    await expect(taxonomyNodeUpdate.run({ nodeId: leafId, attributes: { erp_code: "CHG" } }, t.ctx)).rejects.toThrow(/Unknown attribute 'erp_code'/);
  });

  it("entry.get carries the node's attributes next to the entry-component values", async () => {
    const { entry } = await entryCreate.run({ typeUid: "ta_item", values: { title: "Charger 45W" } }, t.ctx);
    entryId = entry.id;
    await entrySetTaxonomies.run({ typeUid: "ta_item", id: entryId, attachments: [{ nodeId: leafId, entryComponentValues: { wattage: 45 } }] }, t.ctx);
    await expect(
      entrySetTaxonomies.run({ typeUid: "ta_item", id: entryId, attachments: [{ nodeId: rootId, entryComponentValues: { wattage: 1 } }] }, t.ctx),
    ).rejects.toThrow(/has no entry component/);
    const detail = await entryGet.run({ typeUid: "ta_item", id: entryId }, t.ctx);
    expect(detail.taxonomies).toEqual([
      { nodeId: leafId, name: "Chargers", path: "accessories.chargers", taxonomy: "ta_shop", entryComponentUid: "ta_specs", entryComponentValues: { wattage: 45 }, attributes: { sort_order: 1 } },
    ]);
    await publishEntry(t.ctx, "ta_item", entryId);
  });

  it("delivery REST: tree carries attributeFields + node attributes; entries carry attributes / entryComponent / entryComponentValues", async () => {
    const tree = await app.inject({ method: "GET", url: `/delivery/taxonomies/ta_shop?ws=${ws}` });
    expect(tree.statusCode).toBe(200);
    const body = tree.json();
    expect(body.attributeFields.map((f: { name: string }) => f.name)).toEqual(["description", "sort_order", "featured"]);
    expect(body.nodes.find((n: { id: string }) => n.id === leafId)).toMatchObject({ path: "accessories.chargers", attributes: { sort_order: 1 }, entryComponent: "ta_specs" });
    expect(body.nodes[0]).not.toHaveProperty("attributeSet");
    const list = await app.inject({ method: "GET", url: `/delivery/taxonomies?ws=${ws}` });
    expect(list.json().items.find((x: { uid: string }) => x.uid === "ta_shop").attributeFields).toHaveLength(3);

    const one = await app.inject({ method: "GET", url: `/delivery/ta_item/${entryId}?ws=${ws}&taxonomies=1` });
    expect(one.statusCode).toBe(200);
    expect(one.json().taxonomies).toEqual([
      { taxonomy: "ta_shop", nodeId: leafId, name: "Chargers", slug: "chargers", path: "accessories.chargers", attributes: { sort_order: 1 }, entryComponent: "ta_specs", entryComponentValues: { wattage: 45 } },
    ]);
  });

  it("delivery GraphQL exposes the same names", async () => {
    const res = await app.inject({
      method: "POST", url: `/delivery/graphql?ws=${ws}`,
      payload: { query: `{ taxonomy(uid: "ta_shop") { attributeFields nodes { path attributes entryComponent } } taItems { items { title taxonomies { path attributes entryComponent entryComponentValues } } } }` },
    });
    expect(res.statusCode, res.body).toBe(200);
    const d = res.json().data;
    expect(res.json().errors).toBeUndefined();
    expect(d.taxonomy.attributeFields).toHaveLength(3);
    expect(d.taxonomy.nodes.find((n: { path: string }) => n.path === "accessories.chargers")).toEqual({ path: "accessories.chargers", attributes: { sort_order: 1 }, entryComponent: "ta_specs" });
    expect(d.taItems.items[0].taxonomies[0]).toEqual({ path: "accessories.chargers", attributes: { sort_order: 1 }, entryComponent: "ta_specs", entryComponentValues: { wattage: 45 } });
  });

  it("management REST: PATCH /api/taxonomies/:uid edits the fields, PATCH a node sets values", async () => {
    const session = await t.createSession();
    const h = { cookie: `prina_session=${session}`, "x-prina-workspace": ws };
    const patched = await app.inject({ method: "PATCH", url: "/api/taxonomies/ta_shop", headers: h, payload: { description: "Shop tree", attributeFields: [{ name: "description", type: "text" }, { name: "featured", type: "boolean" }] } });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.json().attributeFields).toHaveLength(2);
    const node = await app.inject({ method: "PATCH", url: `/api/taxonomy-nodes/${rootId}`, headers: h, payload: { attributes: { description: "Top", featured: true } } });
    expect(node.statusCode, node.body).toBe(200);
    expect(node.json().attributes).toEqual({ description: "Top", featured: true });
    const bad = await app.inject({ method: "PATCH", url: `/api/taxonomy-nodes/${rootId}`, headers: h, payload: { attributes: { sort_order: 3 } } });
    expect(bad.statusCode).toBe(422);
  });
});
