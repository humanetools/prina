/** Taxonomy on assets (23-IMPL-dam-taxonomy): attach / replace / detach, detail, list filter, cascade, workspace isolation */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { ApiGrantItem, ApiGrantLevel, McpPlane } from "@prina/shared";
import { buildApp } from "../src/app.js";
import { createDb } from "../src/db/client.js";
import { assetConfirmUpload, assetGet, assetList, assetRequestUpload } from "../src/modules/asset/commands.js";
import { assetSetTaxonomies } from "../src/modules/asset/taxonomy-commands.js";
import { taxonomyCreate, taxonomyNodeCreate, taxonomyNodeDelete } from "../src/modules/taxonomy/commands.js";
import { mcpTokenCreate } from "../src/modules/mcp/tokens.js";
import { NotFoundError, ValidationError } from "../src/lib/errors.js";
import { setupTestContext, type TestContext } from "./helpers.js";

let t: TestContext;
let other: TestContext;
let app: FastifyInstance;
let token: string;
const assets = { charger: "", caseShot: "", phone: "", plain: "" };
const nodes = { accessories: "", chargers: "", cases: "", phones: "", launch: "", foreign: "" };

const H = () => ({ authorization: `Bearer ${token}` });

async function upload(ctx: TestContext, filename: string, folder = "/"): Promise<string> {
  const { asset } = await assetRequestUpload.run({ filename, mime: "text/plain", size: 5, folder }, ctx.ctx);
  await ctx.services.storage.adapter.put(asset.storageKey, Buffer.from("hello"), "text/plain");
  return (await assetConfirmUpload.run({ id: asset.id }, ctx.ctx)).id;
}
const names = (r: { items: Array<{ filename: string }> }) => r.items.map((i) => i.filename).sort();

beforeAll(async () => {
  t = await setupTestContext();
  other = await setupTestContext();
  const { db } = createDb(process.env.TEST_DATABASE_URL!);
  app = buildApp({ env: { LOG_LEVEL: "error", NODE_ENV: "test", ADMIN_DIST_PATH: undefined, S3_REGION: "us-east-1" }, db, services: t.services });
  token = (await mcpTokenCreate.run({ name: "at-assets", plane: McpPlane.Management, grants: [{ item: ApiGrantItem.Assets, level: ApiGrantLevel.Edit }] }, t.ctx)).token;

  await taxonomyCreate.run({ uid: "at_shop", name: "Shop" }, t.ctx);
  await taxonomyCreate.run({ uid: "at_campaign", name: "Campaign" }, t.ctx);
  const node = async (ctx: TestContext, taxonomyUid: string, name: string, slug: string, parentId: string | null = null) =>
    (await taxonomyNodeCreate.run({ taxonomyUid, name, slug, parentId, entryComponentUid: null }, ctx.ctx)).id;
  nodes.accessories = await node(t, "at_shop", "Accessories", "accessories");
  nodes.chargers = await node(t, "at_shop", "Chargers", "fast-chargers", nodes.accessories);
  nodes.cases = await node(t, "at_shop", "Cases", "cases", nodes.accessories);
  nodes.phones = await node(t, "at_shop", "Phones", "phones");
  nodes.launch = await node(t, "at_campaign", "Launch", "launch");
  await taxonomyCreate.run({ uid: "at_shop", name: "Other shop" }, other.ctx);
  nodes.foreign = await node(other, "at_shop", "Foreign", "foreign");

  assets.charger = await upload(t, "charger.txt", "/products");
  assets.caseShot = await upload(t, "case.txt", "/products");
  assets.phone = await upload(t, "phone.txt", "/hero");
  assets.plain = await upload(t, "plain.txt");
  await assetSetTaxonomies.run({ id: assets.charger, nodeIds: [nodes.chargers, nodes.launch] }, t.ctx);
  await assetSetTaxonomies.run({ id: assets.caseShot, nodeIds: [nodes.cases] }, t.ctx);
  await assetSetTaxonomies.run({ id: assets.phone, nodeIds: [nodes.phones, nodes.launch] }, t.ctx);
});
afterAll(async () => {
  await app.close();
  await t.cleanup();
  await other.cleanup();
});

describe("asset taxonomy — attach", () => {
  it("returns the attached nodes on the asset detail, ordered by taxonomy and path", async () => {
    const detail = await assetGet.run({ id: assets.charger }, t.ctx);
    expect(detail.taxonomies).toEqual([
      { taxonomy: "at_campaign", nodeId: nodes.launch, name: "Launch", slug: "launch", path: "launch" },
      { taxonomy: "at_shop", nodeId: nodes.chargers, name: "Chargers", slug: "fast-chargers", path: "accessories.fast_chargers" },
    ]);
    expect((await assetGet.run({ id: assets.plain }, t.ctx)).taxonomies).toEqual([]);
  });

  it("replaces the whole set, tolerates duplicates, and detaches everything with []", async () => {
    const id = await upload(t, "replace.txt");
    await assetSetTaxonomies.run({ id, nodeIds: [nodes.cases, nodes.cases] }, t.ctx);
    const replaced = await assetSetTaxonomies.run({ id, nodeIds: [nodes.phones] }, t.ctx);
    expect(replaced.taxonomies.map((n) => n.nodeId)).toEqual([nodes.phones]);
    const cleared = await assetSetTaxonomies.run({ id, nodeIds: [] }, t.ctx);
    expect(cleared.taxonomies).toEqual([]);
    expect((await assetGet.run({ id }, t.ctx)).taxonomies).toEqual([]);
  });

  it("rejects unknown nodes, another workspace's nodes, and unknown assets — nothing is changed", async () => {
    const ghost = "00000000-0000-4000-8000-000000000000";
    await expect(assetSetTaxonomies.run({ id: assets.caseShot, nodeIds: [ghost] }, t.ctx)).rejects.toBeInstanceOf(ValidationError);
    await expect(assetSetTaxonomies.run({ id: assets.caseShot, nodeIds: [nodes.cases, nodes.foreign] }, t.ctx)).rejects.toBeInstanceOf(ValidationError);
    await expect(assetSetTaxonomies.run({ id: assets.caseShot, nodeIds: [nodes.foreign] }, other.ctx)).rejects.toBeInstanceOf(NotFoundError);
    await expect(assetSetTaxonomies.run({ id: ghost, nodeIds: [] }, t.ctx)).rejects.toBeInstanceOf(NotFoundError);
    expect((await assetGet.run({ id: assets.caseShot }, t.ctx)).taxonomies.map((n) => n.nodeId)).toEqual([nodes.cases]);
  });
});

describe("asset taxonomy — list filter", () => {
  it("includes descendants by default and only the node itself with taxonomyExact", async () => {
    expect(names(await assetList.run({ taxonomy: "at_shop:accessories" }, t.ctx))).toEqual(["case.txt", "charger.txt"]);
    expect(names(await assetList.run({ taxonomy: "at_shop:accessories", taxonomyExact: "1" }, t.ctx))).toEqual([]);
    expect(names(await assetList.run({ taxonomy: "at_shop:accessories.fast_chargers", taxonomyExact: true }, t.ctx))).toEqual(["charger.txt"]);
    // slug spelling of the path is accepted, as on the delivery plane
    expect(names(await assetList.run({ taxonomy: "at_shop:accessories.fast-chargers" }, t.ctx))).toEqual(["charger.txt"]);
  });

  it("ANDs several filters, and ANDs with folder and search; total follows the filter", async () => {
    const both = await assetList.run({ taxonomy: ["at_campaign:launch", "at_shop:accessories"] }, t.ctx);
    expect(names(both)).toEqual(["charger.txt"]);
    expect(both.pagination.total).toBe(1);
    expect(names(await assetList.run({ taxonomy: "at_campaign:launch" }, t.ctx))).toEqual(["charger.txt", "phone.txt"]);
    expect(names(await assetList.run({ taxonomy: "at_campaign:launch", folder: "/hero" }, t.ctx))).toEqual(["phone.txt"]);
    expect(names(await assetList.run({ taxonomy: "at_campaign:launch", search: "charg" }, t.ctx))).toEqual(["charger.txt"]);
  });

  it("answers 404 for an unknown taxonomy or node and 422 for a malformed filter", async () => {
    await expect(assetList.run({ taxonomy: "at_nope:launch" }, t.ctx)).rejects.toBeInstanceOf(NotFoundError);
    await expect(assetList.run({ taxonomy: "at_shop:nothing_here" }, t.ctx)).rejects.toBeInstanceOf(NotFoundError);
    await expect(assetList.run({ taxonomy: "no-colon" }, t.ctx)).rejects.toBeInstanceOf(ValidationError);
    await expect(assetList.run({ taxonomy: "at_shop:bad path!" }, t.ctx)).rejects.toBeInstanceOf(ValidationError);
    // the other workspace has an `at_shop` too — its tree is not reachable from here
    await expect(assetList.run({ taxonomy: "at_shop:foreign" }, t.ctx)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("asset taxonomy — HTTP", () => {
  it("PUT /api/assets/:id/taxonomies replaces, GET /api/assets/:id shows it, GET /api/assets filters (repeated parameter = AND)", async () => {
    const id = await upload(t, "http.txt");
    const put = await app.inject({ method: "PUT", url: `/api/assets/${id}/taxonomies`, headers: H(), payload: { nodeIds: [nodes.phones, nodes.launch] } });
    expect(put.statusCode).toBe(200);
    expect(put.json().taxonomies.map((n: { path: string }) => n.path)).toEqual(["launch", "phones"]);
    const detail = await app.inject({ method: "GET", url: `/api/assets/${id}`, headers: H() });
    expect(detail.json().taxonomies).toHaveLength(2);

    const list = await app.inject({ method: "GET", url: "/api/assets?taxonomy=at_shop:phones&taxonomy=at_campaign:launch", headers: H() });
    expect(list.statusCode).toBe(200);
    expect(names(list.json())).toEqual(["http.txt", "phone.txt"]);
    expect((await app.inject({ method: "GET", url: "/api/assets?taxonomy=at_shop:phones&taxonomyExact=1", headers: H() })).statusCode).toBe(200);

    expect((await app.inject({ method: "GET", url: "/api/assets?taxonomy=broken", headers: H() })).statusCode).toBe(422);
    expect((await app.inject({ method: "GET", url: "/api/assets?taxonomy=at_shop:gone", headers: H() })).statusCode).toBe(404);
    expect((await app.inject({ method: "PUT", url: `/api/assets/${id}/taxonomies`, headers: H(), payload: { nodeIds: ["not-a-uuid"] } })).statusCode).toBe(422);
    expect((await app.inject({ method: "PUT", url: `/api/assets/${id}/taxonomies`, headers: H(), payload: { nodeIds: [nodes.foreign] } })).statusCode).toBe(422);
  });
});

describe("asset taxonomy — cascade", () => {
  it("accepts up to 1,000 node ids and rejects 1,001 (shared images sit in hundreds of nodes)", async () => {
    const { randomUUID } = await import("node:crypto");
    const ids = (n: number) => Array.from({ length: n }, () => randomUUID());
    // 1,000 unknown ids pass the input schema and fail on lookup — the ceiling is the schema's, not the DB's
    await expect(assetSetTaxonomies.run({ id: assets.charger, nodeIds: ids(1000) }, t.ctx)).rejects.toThrow(/not found/);
    await expect(assetSetTaxonomies.run({ id: assets.charger, nodeIds: ids(1001) }, t.ctx)).rejects.toThrow(/not valid/);
    const { entrySetTaxonomies } = await import("../src/modules/entry/document-commands.js");
    const { entryCreate } = await import("../src/modules/entry/commands.js");
    const { contentTypeCreate } = await import("../src/modules/content-type/commands.js");
    await contentTypeCreate.run({ uid: "at_item", name: "Item", definition: { fields: [{ name: "title", type: "text" }] } }, t.ctx);
    const { entry } = await entryCreate.run({ typeUid: "at_item", values: { title: "x" } }, t.ctx);
    const att = (n: number) => ids(n).map((nodeId) => ({ nodeId }));
    await expect(entrySetTaxonomies.run({ typeUid: "at_item", id: entry.id, attachments: att(1000) }, t.ctx)).rejects.toThrow(/not found/);
    await expect(entrySetTaxonomies.run({ typeUid: "at_item", id: entry.id, attachments: att(1001) }, t.ctx)).rejects.toThrow(/not valid/);
  });

  it("deleting a node (with its subtree) removes the asset attachments under it", async () => {
    const parent = (await taxonomyNodeCreate.run({ taxonomyUid: "at_shop", name: "Temp", slug: "temp", parentId: null, entryComponentUid: null }, t.ctx)).id;
    const child = (await taxonomyNodeCreate.run({ taxonomyUid: "at_shop", name: "Temp child", slug: "temp-child", parentId: parent, entryComponentUid: null }, t.ctx)).id;
    const id = await upload(t, "cascade.txt");
    await assetSetTaxonomies.run({ id, nodeIds: [child, nodes.launch] }, t.ctx);
    await taxonomyNodeDelete.run({ nodeId: parent }, t.ctx);
    expect((await assetGet.run({ id }, t.ctx)).taxonomies.map((n) => n.nodeId)).toEqual([nodes.launch]);
  });
});
