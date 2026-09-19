/** Management entry list with taxonomy (27-IMPL): include=taxonomies and the taxonomy filter — drafts included */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { ApiGrantItem, ApiGrantLevel, McpPlane } from "@prina/shared";
import { buildApp } from "../src/app.js";
import { createDb } from "../src/db/client.js";
import { contentTypeCreate } from "../src/modules/content-type/commands.js";
import { componentCreate } from "../src/modules/content-type/component-commands.js";
import { entryCreate, entryGet, entryList } from "../src/modules/entry/commands.js";
import { entrySetTaxonomies } from "../src/modules/entry/document-commands.js";
import { taxonomyCreate, taxonomyNodeCreate } from "../src/modules/taxonomy/commands.js";
import { mcpTokenCreate } from "../src/modules/mcp/tokens.js";
import { NotFoundError, ValidationError } from "../src/lib/errors.js";
import { publishEntry, setupTestContext, type TestContext } from "./helpers.js";

let t: TestContext;
let app: FastifyInstance;
let readToken: string;
const ids = { camera: "", robot: "", robotDraft: "", plain: "", other: "" };
const nodes = { unit: "", vision: "", robots: "", launch: "" };

type Item = { id: string; values: Record<string, unknown>; taxonomies?: Array<{ nodeId: string }> };
const titles = (r: { items: Item[] }) => r.items.map((i) => String(i.values.title)).sort();

beforeAll(async () => {
  t = await setupTestContext();
  const { db } = createDb(process.env.TEST_DATABASE_URL!);
  app = buildApp({ env: { LOG_LEVEL: "error", NODE_ENV: "test", ADMIN_DIST_PATH: undefined, S3_REGION: "us-east-1" }, db, services: t.services });
  readToken = (await mcpTokenCreate.run({ name: "lt-read", plane: McpPlane.Management, grants: [{ item: ApiGrantItem.Entries, level: ApiGrantLevel.Read }] }, t.ctx)).token;

  const def = { fields: [{ name: "title", type: "text", required: true }], displayField: "title" };
  await contentTypeCreate.run({ uid: "lt_page", name: "Page", definition: def }, t.ctx);
  await contentTypeCreate.run({ uid: "lt_other", name: "Other", definition: def }, t.ctx);
  await componentCreate.run({ uid: "lt_vision_attrs", name: "Vision attrs", definition: { fields: [{ name: "megapixels", type: "number" }] } }, t.ctx);
  await taxonomyCreate.run({ uid: "lt-unit", name: "Business unit" }, t.ctx);
  await taxonomyCreate.run({ uid: "lt-campaign", name: "Campaign" }, t.ctx);
  const node = async (taxonomyUid: string, name: string, slug: string, parentId: string | null = null, attributeComponentUid: string | null = null) =>
    (await taxonomyNodeCreate.run({ taxonomyUid, name, slug, parentId, attributeComponentUid }, t.ctx)).id;
  nodes.unit = await node("lt-unit", "Business Unit", "business-unit");
  nodes.vision = await node("lt-unit", "Machine Vision", "machine-vision", nodes.unit, "lt_vision_attrs");
  nodes.robots = await node("lt-unit", "Mobile Robot", "mobile-robot", nodes.unit);
  nodes.launch = await node("lt-campaign", "Launch", "launch");

  const make = async (typeUid: string, title: string, publish: boolean) => {
    const { entry } = await entryCreate.run({ typeUid, values: { title } }, t.ctx);
    if (publish) await publishEntry(t.ctx, typeUid, entry.id);
    return entry.id;
  };
  ids.camera = await make("lt_page", "Camera", true);
  ids.robot = await make("lt_page", "Robot", true);
  ids.robotDraft = await make("lt_page", "Robot draft", false);
  ids.plain = await make("lt_page", "Unclassified", false);
  ids.other = await make("lt_other", "Other type", true);
  const attach = (typeUid: string, id: string, attachments: Array<{ nodeId: string; attributeValues?: Record<string, unknown> }>) =>
    entrySetTaxonomies.run({ typeUid, id, attachments }, t.ctx);
  await attach("lt_page", ids.camera, [{ nodeId: nodes.vision, attributeValues: { megapixels: 12 } }, { nodeId: nodes.launch }]);
  await attach("lt_page", ids.robot, [{ nodeId: nodes.robots }]);
  await attach("lt_page", ids.robotDraft, [{ nodeId: nodes.robots }, { nodeId: nodes.launch }]);
  await attach("lt_other", ids.other, [{ nodeId: nodes.vision }]);
});
afterAll(async () => {
  await app.close();
  await t.cleanup();
});

describe("entry.list — include=taxonomies", () => {
  it("adds nothing unless asked: no `taxonomies` key on the items", async () => {
    const res = await entryList.run({ typeUid: "lt_page" }, t.ctx);
    expect(res.items).toHaveLength(4);
    expect(res.items.every((i) => !("taxonomies" in i))).toBe(true);
  });

  it("gives every row — drafts too — the same shape the single-entry read returns; [] when nothing is attached", async () => {
    const res = await entryList.run({ typeUid: "lt_page", include: "taxonomies" }, t.ctx);
    const byId = new Map(res.items.map((i) => [i.id, i.taxonomies]));
    expect(byId.get(ids.camera)).toEqual([
      { nodeId: nodes.launch, name: "Launch", path: "launch", taxonomy: "lt-campaign", attributeValues: null, attributeComponentUid: null },
      { nodeId: nodes.vision, name: "Machine Vision", path: "business_unit.machine_vision", taxonomy: "lt-unit", attributeValues: { megapixels: 12 }, attributeComponentUid: "lt_vision_attrs" },
    ]);
    expect(byId.get(ids.robotDraft)!.map((x) => x.nodeId).sort()).toEqual([nodes.launch, nodes.robots].sort());
    expect(byId.get(ids.plain)).toEqual([]);
    for (const id of [ids.camera, ids.robotDraft, ids.plain]) {
      expect(byId.get(id)).toEqual((await entryGet.run({ typeUid: "lt_page", id }, t.ctx)).taxonomies);
    }
  });

  it("accepts a list or a comma-separated value and rejects an unknown include", async () => {
    expect(((await entryList.run({ typeUid: "lt_page", include: ["taxonomies"] }, t.ctx)).items[0]!).taxonomies).toBeDefined();
    expect(((await entryList.run({ typeUid: "lt_page", include: " taxonomies , " }, t.ctx)).items[0]!).taxonomies).toBeDefined();
    await expect(entryList.run({ typeUid: "lt_page", include: "taxonomy" }, t.ctx)).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("entry.list — taxonomy filter", () => {
  it("includes descendants by default, drafts included, and stays inside the content type; total follows", async () => {
    const all = await entryList.run({ typeUid: "lt_page", taxonomy: "lt-unit:business_unit" }, t.ctx);
    expect(titles(all)).toEqual(["Camera", "Robot", "Robot draft"]);
    expect(all.pagination.total).toBe(3);
    expect(titles(await entryList.run({ typeUid: "lt_page", taxonomy: "lt-unit:business_unit.mobile_robot" }, t.ctx))).toEqual(["Robot", "Robot draft"]);
    // slug spelling, as on the delivery plane
    expect(titles(await entryList.run({ typeUid: "lt_page", taxonomy: "lt-unit:business-unit.machine-vision" }, t.ctx))).toEqual(["Camera"]);
    expect(titles(await entryList.run({ typeUid: "lt_page", taxonomy: "lt-unit:business_unit", taxonomyExact: "1" }, t.ctx))).toEqual([]);
  });

  it("ANDs several filters and ANDs with status / search / paging", async () => {
    expect(titles(await entryList.run({ typeUid: "lt_page", taxonomy: ["lt-unit:business_unit.mobile_robot", "lt-campaign:launch"] }, t.ctx))).toEqual(["Robot draft"]);
    expect(titles(await entryList.run({ typeUid: "lt_page", taxonomy: "lt-unit:business_unit.mobile_robot", status: "published" }, t.ctx))).toEqual(["Robot"]);
    expect(titles(await entryList.run({ typeUid: "lt_page", taxonomy: "lt-campaign:launch", search: "camera" }, t.ctx))).toEqual(["Camera"]);
    const page2 = await entryList.run({ typeUid: "lt_page", taxonomy: "lt-unit:business_unit", pageSize: 2, page: 2, sort: "display:asc", include: "taxonomies" }, t.ctx);
    expect(titles(page2)).toEqual(["Robot draft"]);
    expect(page2.pagination).toMatchObject({ total: 3, pageCount: 2 });
    expect((page2.items[0]!).taxonomies).toHaveLength(2);
  });

  it("answers 404 for an unknown taxonomy or node and 422 for a malformed filter", async () => {
    await expect(entryList.run({ typeUid: "lt_page", taxonomy: "lt-nope:x" }, t.ctx)).rejects.toBeInstanceOf(NotFoundError);
    await expect(entryList.run({ typeUid: "lt_page", taxonomy: "lt-unit:business_unit.gone" }, t.ctx)).rejects.toBeInstanceOf(NotFoundError);
    await expect(entryList.run({ typeUid: "lt_page", taxonomy: "no-colon" }, t.ctx)).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("entry.list — HTTP with an access token (entries: read)", () => {
  const H = () => ({ authorization: `Bearer ${readToken}` });
  it("one call returns the filtered page with each row's taxonomy nodes", async () => {
    const res = await app.inject({ method: "GET", url: "/api/content/lt_page?include=taxonomies&taxonomy=lt-unit:business_unit.mobile_robot&taxonomy=lt-campaign:launch", headers: H() });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.pagination.total).toBe(1);
    expect(body.items[0].values.title).toBe("Robot draft");
    expect(body.items[0].taxonomies.map((x: { taxonomy: string; path: string }) => `${x.taxonomy}:${x.path}`)).toEqual(["lt-campaign:launch", "lt-unit:business_unit.mobile_robot"]);
  });

  it("maps errors to 404 / 422 and leaves the plain list unchanged", async () => {
    expect((await app.inject({ method: "GET", url: "/api/content/lt_page?taxonomy=lt-unit:nothing", headers: H() })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/content/lt_page?taxonomy=broken", headers: H() })).statusCode).toBe(422);
    expect((await app.inject({ method: "GET", url: "/api/content/lt_page?include=everything", headers: H() })).statusCode).toBe(422);
    const plain = (await app.inject({ method: "GET", url: "/api/content/lt_page", headers: H() })).json();
    expect(plain.items).toHaveLength(4);
    expect("taxonomies" in plain.items[0]).toBe(false);
  });

  it("documents the parameters on the list operation", async () => {
    const spec = (await app.inject({ method: "GET", url: "/openapi.json", headers: { "x-prina-workspace": t.workspaceSlug, "x-prina-actor": `human:${t.userId}` } })).json();
    const names = (path: string) => spec.paths[path].get.parameters.map((p: { name: string }) => p.name);
    expect(names("/api/content/{typeUid}")).toEqual(expect.arrayContaining(["taxonomy", "taxonomyExact", "include"]));
    // the per-type operation generated for each content type carries them too
    expect(names("/api/content/lt_page")).toEqual(expect.arrayContaining(["taxonomy", "taxonomyExact", "include"]));
  });
});
