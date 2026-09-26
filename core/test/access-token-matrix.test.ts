/**
 * 20-IMPL custom grants — every token-reachable /api route, exercised end to end with a read-only
 * grant token and an edit grant token (no role): the hook must classify each call and the
 * permission rows synthesised from the grants must satisfy the command behind it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { ApiGrantItem, ApiGrantLevel, McpPlane, type ApiGrant } from "@prina/shared";
import { buildApp } from "../src/app.js";
import { createDb } from "../src/db/client.js";
import { mcpTokenCreate } from "../src/modules/mcp/tokens.js";
import { setupTestContext, type TestContext } from "./helpers.js";

let t: TestContext;
let app: FastifyInstance;
let readTok: string;
let editTok: string;
let typedTok: string;

const H = (token: string) => ({ authorization: `Bearer ${token}` });
const READ_ITEMS = [ApiGrantItem.ContentTypes, ApiGrantItem.Components, ApiGrantItem.Entries, ApiGrantItem.Assets, ApiGrantItem.Templates, ApiGrantItem.Locales, ApiGrantItem.Taxonomies];
const ALL_ITEMS = Object.values(ApiGrantItem);

/** Walks the entry to published whatever the seeded workflow is (OSS: direct; EE: review → approved → published) */
async function publishVia(token: string, typeUid: string, id: string): Promise<number> {
  const post = (to: string) => app.inject({ method: "POST", url: `/api/content/${typeUid}/${id}/transition`, headers: H(token), payload: { to } });
  let res = await post("published");
  if (res.statusCode === 200) return 200;
  for (const to of ["review", "approved", "published"]) { res = await post(to); if (res.statusCode !== 200) return res.statusCode; }
  return 200;
}

const okStatus = (res: { statusCode: number }, label: string) =>
  expect([200, 201, 204], `${label} → ${res.statusCode}`).toContain(res.statusCode);
const denied = (res: { statusCode: number; json(): { error: { code: string } } }, label: string) => {
  expect(res.statusCode, label).toBe(403);
  expect(res.json().error.code, label).toBe("SCOPE_DENIED");
};

beforeAll(async () => {
  t = await setupTestContext();
  const { db } = createDb(process.env.TEST_DATABASE_URL!);
  app = buildApp({ env: { LOG_LEVEL: "error", NODE_ENV: "test", ADMIN_DIST_PATH: undefined, S3_REGION: "us-east-1" }, db, services: t.services });
  const issue = async (name: string, grants: ApiGrant[]) =>
    (await mcpTokenCreate.run({ name, plane: McpPlane.Management, grants }, t.ctx)).token;
  readTok = await issue("mx-read", READ_ITEMS.map((item) => ({ item, level: ApiGrantLevel.Read })));
  editTok = await issue("mx-edit", ALL_ITEMS.map((item) => ({ item, level: ApiGrantLevel.Edit })));
  typedTok = await issue("mx-typed", [
    { item: ApiGrantItem.Entries, level: ApiGrantLevel.Edit, types: ["mx_a"] },
    { item: ApiGrantItem.Publish, level: ApiGrantLevel.Edit, types: ["mx_a"] },
    { item: ApiGrantItem.Import, level: ApiGrantLevel.Edit, types: ["mx_a"] },
  ]);
});
afterAll(async () => { await app.close(); await t.cleanup(); });

describe("CTB — content types (+presets, schema.org) and components", () => {
  it("edit token: create / get / update / list / delete a type; read token: reads only", async () => {
    const def = { fields: [{ name: "title", type: "text", required: true }, { name: "tag", type: "text" }], displayField: "title" };
    okStatus(await app.inject({ method: "POST", url: "/api/content-types", headers: H(editTok), payload: { uid: "mx_a", name: "MX A", schemaOrgType: "Article", definition: def } }), "POST content-types");
    okStatus(await app.inject({ method: "POST", url: "/api/content-types", headers: H(editTok), payload: { uid: "mx_b", name: "MX B", definition: def } }), "POST content-types (b)");
    okStatus(await app.inject({ method: "GET", url: "/api/content-types", headers: H(readTok) }), "GET content-types");
    okStatus(await app.inject({ method: "GET", url: "/api/content-types/mx_a", headers: H(readTok) }), "GET content-types/:uid");
    okStatus(await app.inject({ method: "PUT", url: "/api/content-types/mx_b", headers: H(editTok), payload: { name: "MX B2" } }), "PUT content-types/:uid");
    denied(await app.inject({ method: "PUT", url: "/api/content-types/mx_b", headers: H(readTok), payload: { name: "nope" } }), "PUT content-types (read token)");
    denied(await app.inject({ method: "POST", url: "/api/content-types", headers: H(readTok), payload: { uid: "mx_c", name: "c", definition: def } }), "POST content-types (read token)");
    for (const url of ["/api/schema-org/types", "/api/schema-org/properties", "/api/schema-org/inverse?prop=author", "/api/schema-org/validate?types=Article&props=author", "/api/presets"]) {
      okStatus(await app.inject({ method: "GET", url, headers: H(readTok) }), `GET ${url}`);
    }
    okStatus(await app.inject({ method: "POST", url: "/api/presets/product/install", headers: H(editTok) }), "POST presets install");
    denied(await app.inject({ method: "POST", url: "/api/presets/product/install", headers: H(readTok) }), "POST presets install (read token)");
    // jsonld-sample derives from the type definition alone — same data a content-types read already exposes
    okStatus(await app.inject({ method: "GET", url: "/api/content-types/mx_a/jsonld-sample", headers: H(readTok) }), "GET jsonld-sample (read token)");
  });

  it("components: read token lists, edit token creates / updates / deletes", async () => {
    okStatus(await app.inject({ method: "POST", url: "/api/components", headers: H(editTok), payload: { uid: "mx.block", name: "MX block", definition: { fields: [{ name: "h", type: "text" }] } } }), "POST components");
    okStatus(await app.inject({ method: "GET", url: "/api/components", headers: H(readTok) }), "GET components");
    okStatus(await app.inject({ method: "PUT", url: "/api/components/mx.block", headers: H(editTok), payload: { name: "MX block 2" } }), "PUT components/:uid");
    denied(await app.inject({ method: "PUT", url: "/api/components/mx.block", headers: H(readTok), payload: { name: "x" } }), "PUT components (read token)");
    okStatus(await app.inject({ method: "DELETE", url: "/api/components/mx.block", headers: H(editTok) }), "DELETE components/:uid");
  });
});

describe("Content — entries, publish, import, draft preview", () => {
  let id = "";
  let documentId = "";
  let taxonomyNodeId = "";

  it("entries: full CRUD + duplicate / seo / taxonomies / traverse / jsonld-preview / document; read token reads only", async () => {
    // a taxonomy node to attach (edit token on the taxonomies item)
    okStatus(await app.inject({ method: "POST", url: "/api/taxonomies", headers: H(editTok), payload: { uid: "mx_tax", name: "MX tax" } }), "POST taxonomies");
    const node = await app.inject({ method: "POST", url: "/api/taxonomies/mx_tax/nodes", headers: H(editTok), payload: { name: "Root", slug: "root", parentId: null } });
    okStatus(node, "POST taxonomies/:uid/nodes");
    taxonomyNodeId = node.json().id ?? node.json().node?.id;

    const created = await app.inject({ method: "POST", url: "/api/content/mx_a", headers: H(editTok), payload: { values: { title: "MX entry", tag: "t1" } } });
    okStatus(created, "POST content/:type");
    id = created.json().entry.id; documentId = created.json().entry.documentId;
    denied(await app.inject({ method: "POST", url: "/api/content/mx_a", headers: H(readTok), payload: { values: { title: "nope" } } }), "POST content (read token)");

    okStatus(await app.inject({ method: "GET", url: "/api/content/mx_a", headers: H(readTok) }), "GET content/:type");
    okStatus(await app.inject({ method: "GET", url: `/api/content/mx_a/${id}`, headers: H(readTok) }), "GET content/:type/:id");
    okStatus(await app.inject({ method: "GET", url: `/api/content/mx_a/document/${documentId}`, headers: H(readTok) }), "GET content/:type/document/:documentId");
    okStatus(await app.inject({ method: "GET", url: `/api/content/mx_a/${id}/traverse?depth=1`, headers: H(readTok) }), "GET traverse");
    okStatus(await app.inject({ method: "GET", url: `/api/content/mx_a/${id}/jsonld-preview`, headers: H(readTok) }), "GET jsonld-preview");

    okStatus(await app.inject({ method: "PUT", url: `/api/content/mx_a/${id}`, headers: H(editTok), payload: { values: { title: "MX entry 2", tag: "t2" } } }), "PUT content/:type/:id");
    okStatus(await app.inject({ method: "PUT", url: `/api/content/mx_a/${id}/seo`, headers: H(editTok), payload: { seo: { metaTitle: "MX" } } }), "PUT seo");
    okStatus(await app.inject({ method: "PUT", url: `/api/content/mx_a/${id}/taxonomies`, headers: H(editTok), payload: { attachments: [{ nodeId: taxonomyNodeId }] } }), "PUT taxonomies");
    // AI translate (28-IMPL) — reachable with the edit token (answers 4xx here: no target locale / AI set up), never for read
    const tr = await app.inject({ method: "POST", url: `/api/content/mx_a/${id}/translate`, headers: H(editTok), payload: { targetLocale: "zz" } });
    expect(tr.statusCode, "translate (edit token)").not.toBe(403);
    denied(await app.inject({ method: "POST", url: `/api/content/mx_a/${id}/translate`, headers: H(readTok), payload: { targetLocale: "zz" } }), "translate (read token)");
    const dup = await app.inject({ method: "POST", url: `/api/content/mx_a/${id}/duplicate`, headers: H(editTok) });
    okStatus(dup, "POST duplicate");
    for (const [m, url] of [["PUT", `/api/content/mx_a/${id}`], ["PUT", `/api/content/mx_a/${id}/seo`], ["POST", `/api/content/mx_a/${id}/duplicate`], ["DELETE", `/api/content/mx_a/${id}`]] as const) {
      denied(await app.inject({ method: m, url, headers: H(readTok), ...(m === "DELETE" ? {} : { payload: {} }) }), `${m} ${url} (read token)`);
    }
    okStatus(await app.inject({ method: "DELETE", url: `/api/content/mx_a/${dup.json().entry?.id ?? dup.json().id}`, headers: H(editTok) }), "DELETE duplicate");
  });

  it("publish: its own item — an entries-only token cannot transition, the edit token can", async () => {
    const entriesOnly = (await mcpTokenCreate.run({ name: "mx-entries-only", plane: McpPlane.Management, grants: [{ item: ApiGrantItem.Entries, level: ApiGrantLevel.Edit }] }, t.ctx)).token;
    const no = await app.inject({ method: "POST", url: `/api/content/mx_a/${id}/transition`, headers: H(entriesOnly), payload: { to: "published" } });
    denied(no, "transition (entries-only token)");
    expect(no.json().error.details.item).toBe("publish");
    expect(await publishVia(editTok, "mx_a", id), "transition (edit token)").toBe(200);
    expect((await app.inject({ method: "GET", url: `/api/content/mx_a/${id}`, headers: H(readTok) })).json().entry.status).toBe("published");
  });

  it("typed token: only its type, on every entries route; the other type is SCOPE_DENIED with the type named", async () => {
    okStatus(await app.inject({ method: "GET", url: "/api/content/mx_a", headers: H(typedTok) }), "GET mx_a (typed)");
    const b = await app.inject({ method: "GET", url: "/api/content/mx_b", headers: H(typedTok) });
    denied(b, "GET mx_b (typed)");
    expect(b.json().error.details).toMatchObject({ item: "entries", typeUid: "mx_b", granted: { types: ["mx_a"] } });
    const mk = await app.inject({ method: "POST", url: "/api/content/mx_a", headers: H(typedTok), payload: { values: { title: "typed" } } });
    okStatus(mk, "POST mx_a (typed)");
    expect(await publishVia(typedTok, "mx_a", mk.json().entry.id), "transition mx_a (typed publish)").toBe(200);
    denied(await app.inject({ method: "POST", url: "/api/content/mx_b", headers: H(typedTok), payload: { values: { title: "x" } } }), "POST mx_b (typed)");
    // draft preview links need content:* read — a type-limited token is refused by the permission layer, not the hook
    const draft = await app.inject({ method: "POST", url: "/api/delivery/draft-token", headers: H(typedTok), payload: {} });
    expect(draft.statusCode).toBe(403);
    expect(draft.json().error.code).toBe("FORBIDDEN");
    okStatus(await app.inject({ method: "POST", url: "/api/delivery/draft-token", headers: H(editTok), payload: {} }), "draft-token (edit token, all types)");
    okStatus(await app.inject({ method: "POST", url: "/api/delivery/draft-token", headers: H(readTok), payload: {} }), "draft-token (read token, all types)");
  });

  it("import: parse / validate / execute with the import item (edit only); read token has no import grant", async () => {
    const csv = Buffer.from("title,tag\nimported one,x\nimported two,y\n").toString("base64");
    const parsed = await app.inject({ method: "POST", url: "/api/import/parse", headers: H(editTok), payload: { filename: "a.csv", dataBase64: csv } });
    okStatus(parsed, "POST import/parse");
    const rows = [{ title: "imported one", tag: "x" }, { title: "imported two", tag: "y" }];
    okStatus(await app.inject({ method: "POST", url: "/api/import/validate", headers: H(editTok), payload: { typeUid: "mx_a", mapping: { title: "title", tag: "tag" }, rows } }), "POST import/validate");
    okStatus(await app.inject({ method: "POST", url: "/api/import/execute", headers: H(editTok), payload: { typeUid: "mx_a", mapping: { title: "title", tag: "tag" }, rows } }), "POST import/execute");
    denied(await app.inject({ method: "POST", url: "/api/import/parse", headers: H(readTok), payload: { filename: "a.csv", dataBase64: csv } }), "import/parse (read token)");
    // typed import: mx_a ok, mx_b refused by the permission layer (the hook cannot see the type in the body)
    okStatus(await app.inject({ method: "POST", url: "/api/import/validate", headers: H(typedTok), payload: { typeUid: "mx_a", mapping: { title: "title" }, rows: [{ title: "z" }] } }), "import/validate mx_a (typed)");
    const other = await app.inject({ method: "POST", url: "/api/import/validate", headers: H(typedTok), payload: { typeUid: "mx_b", mapping: { title: "title" }, rows: [{ title: "z" }] } });
    expect(other.statusCode).toBe(403);
    expect(other.json().error.code).toBe("FORBIDDEN");
  });
});

describe("Media — assets", () => {
  it("edit token: request upload → put (local adapter) → confirm → patch alt → analyze → delete; read token: list / get / folders", async () => {
    const req = await app.inject({ method: "POST", url: "/api/assets/uploads", headers: H(editTok), payload: { filename: "mx.txt", mime: "text/plain", size: 5 } });
    okStatus(req, "POST assets/uploads");
    const { asset, upload } = req.json();
    denied(await app.inject({ method: "POST", url: "/api/assets/uploads", headers: H(readTok), payload: { filename: "n.txt", mime: "text/plain", size: 1 } }), "assets/uploads (read token)");
    if (t.services.storage.adapter.kind === "local") {
      const put = await app.inject({ method: "PUT", url: upload.url, headers: { authorization: `Bearer ${editTok}`, "content-type": "application/octet-stream" }, payload: Buffer.from("hello") });
      okStatus(put, "PUT assets/local-upload");
      okStatus(await app.inject({ method: "POST", url: `/api/assets/${asset.id}/confirm`, headers: H(editTok) }), "POST assets/:id/confirm");
      okStatus(await app.inject({ method: "GET", url: `/api/assets/raw/${encodeURIComponent(asset.storageKey)}`, headers: H(readTok) }), "GET assets/raw/:key");
    }
    okStatus(await app.inject({ method: "GET", url: "/api/assets", headers: H(readTok) }), "GET assets");
    okStatus(await app.inject({ method: "GET", url: `/api/assets/${asset.id}`, headers: H(readTok) }), "GET assets/:id");
    okStatus(await app.inject({ method: "GET", url: "/api/assets/folders", headers: H(readTok) }), "GET assets/folders");
    okStatus(await app.inject({ method: "PATCH", url: `/api/assets/${asset.id}`, headers: H(editTok), payload: { alt: "hello file" } }), "PATCH assets/:id");
    denied(await app.inject({ method: "PATCH", url: `/api/assets/${asset.id}`, headers: H(readTok), payload: { alt: "x" } }), "PATCH assets (read token)");
    okStatus(await app.inject({ method: "GET", url: "/api/assets/folder-tree", headers: H(readTok) }), "GET assets/folder-tree");
    okStatus(await app.inject({ method: "POST", url: "/api/assets/folders", headers: H(editTok), payload: { path: "/mx-folder" } }), "POST assets/folders");
    denied(await app.inject({ method: "POST", url: "/api/assets/folders", headers: H(readTok), payload: { path: "/mx-nope" } }), "POST assets/folders (read token)");
    okStatus(await app.inject({ method: "PATCH", url: "/api/assets/folders", headers: H(editTok), payload: { path: "/mx-folder", newPath: "/mx-folder-2" } }), "PATCH assets/folders");
    denied(await app.inject({ method: "PATCH", url: "/api/assets/folders", headers: H(readTok), payload: { path: "/mx-folder-2", newPath: "/mx-folder-3" } }), "PATCH assets/folders (read token)");
    denied(await app.inject({ method: "DELETE", url: "/api/assets/folders?path=/mx-folder-2", headers: H(readTok) }), "DELETE assets/folders (read token)");
    okStatus(await app.inject({ method: "DELETE", url: "/api/assets/folders?path=/mx-folder-2", headers: H(editTok) }), "DELETE assets/folders");
    okStatus(await app.inject({ method: "PUT", url: `/api/assets/${asset.id}/taxonomies`, headers: H(editTok), payload: { nodeIds: [] } }), "PUT assets/:id/taxonomies");
    denied(await app.inject({ method: "PUT", url: `/api/assets/${asset.id}/taxonomies`, headers: H(readTok), payload: { nodeIds: [] } }), "PUT assets/:id/taxonomies (read token)");
    // analyze is a write (re-runs contrast analysis) — non-image assets are answered, never 403 for the edit token
    const an = await app.inject({ method: "POST", url: `/api/assets/${asset.id}/analyze`, headers: H(editTok) });
    expect(an.statusCode, "analyze").not.toBe(403);
    denied(await app.inject({ method: "POST", url: `/api/assets/${asset.id}/analyze`, headers: H(readTok) }), "analyze (read token)");
    okStatus(await app.inject({ method: "DELETE", url: `/api/assets/${asset.id}`, headers: H(editTok) }), "DELETE assets/:id");
  });
});

describe("Templates, Locales, Taxonomies", () => {
  it("templates: edit token saves (incl. script.js) and activates; read token gets and previews", async () => {
    const e = await app.inject({ method: "POST", url: "/api/content/mx_b", headers: H(editTok), payload: { values: { title: "for preview" } } });
    okStatus(e, "POST content/mx_b");
    okStatus(await app.inject({ method: "PUT", url: "/api/templates/mx_b", headers: H(editTok), payload: { liquid: "<h1>{{ values.title }}</h1>", css: ".x{}", js: "console.log(1)" } }), "PUT templates/:type (with script.js)");
    okStatus(await app.inject({ method: "PUT", url: "/api/templates/mx_b", headers: H(editTok), payload: { liquid: "<h2>{{ values.title }}</h2>", css: "" } }), "PUT templates/:type (v2)");
    okStatus(await app.inject({ method: "GET", url: "/api/templates/mx_b", headers: H(readTok) }), "GET templates/:type");
    okStatus(await app.inject({ method: "POST", url: "/api/templates/mx_b/preview", headers: H(readTok), payload: { entryId: e.json().entry.id, liquid: "<p>{{ values.title }}</p>" } }), "POST templates preview (read token)");
    okStatus(await app.inject({ method: "POST", url: "/api/templates/mx_b/versions/1/activate", headers: H(editTok) }), "POST templates activate");
    denied(await app.inject({ method: "PUT", url: "/api/templates/mx_b", headers: H(readTok), payload: { liquid: "x", css: "" } }), "PUT templates (read token)");
    denied(await app.inject({ method: "POST", url: "/api/templates/mx_b/versions/1/activate", headers: H(readTok) }), "activate (read token)");
  });

  it("locales: edit token create / patch / delete; read token lists", async () => {
    okStatus(await app.inject({ method: "POST", url: "/api/locales", headers: H(editTok), payload: { code: "mx", name: "MX" } }), "POST locales");
    okStatus(await app.inject({ method: "GET", url: "/api/locales", headers: H(readTok) }), "GET locales");
    okStatus(await app.inject({ method: "PATCH", url: "/api/locales/mx", headers: H(editTok), payload: { name: "MX 2" } }), "PATCH locales/:code");
    denied(await app.inject({ method: "PATCH", url: "/api/locales/mx", headers: H(readTok), payload: { name: "x" } }), "PATCH locales (read token)");
    okStatus(await app.inject({ method: "DELETE", url: "/api/locales/mx", headers: H(editTok) }), "DELETE locales/:code");
  });

  it("taxonomies: tree / move / node delete", async () => {
    okStatus(await app.inject({ method: "GET", url: "/api/taxonomies", headers: H(readTok) }), "GET taxonomies");
    okStatus(await app.inject({ method: "GET", url: "/api/taxonomies/mx_tax/tree", headers: H(readTok) }), "GET taxonomies/:uid/tree");
    const child = await app.inject({ method: "POST", url: "/api/taxonomies/mx_tax/nodes", headers: H(editTok), payload: { name: "Child", slug: "child", parentId: null } });
    okStatus(child, "POST nodes (child)");
    const childId = child.json().id ?? child.json().node?.id;
    okStatus(await app.inject({ method: "PATCH", url: `/api/taxonomy-nodes/${childId}`, headers: H(editTok), payload: { name: "renamed" } }), "PATCH taxonomy-nodes/:id");
    denied(await app.inject({ method: "PATCH", url: `/api/taxonomy-nodes/${childId}`, headers: H(readTok), payload: { name: "nope" } }), "PATCH taxonomy-nodes/:id (read token)");
    okStatus(await app.inject({ method: "PUT", url: `/api/taxonomy-nodes/${childId}/move`, headers: H(editTok), payload: { newParentId: null } }), "PUT taxonomy-nodes/:id/move");
    denied(await app.inject({ method: "PUT", url: `/api/taxonomy-nodes/${childId}/move`, headers: H(readTok), payload: { newParentId: null } }), "move (read token)");
    denied(await app.inject({ method: "POST", url: "/api/taxonomies", headers: H(readTok), payload: { uid: "mx_no", name: "n" } }), "POST taxonomies (read token)");
    okStatus(await app.inject({ method: "DELETE", url: `/api/taxonomy-nodes/${childId}`, headers: H(editTok) }), "DELETE taxonomy-nodes/:id");
    okStatus(await app.inject({ method: "POST", url: "/api/taxonomies", headers: H(editTok), payload: { uid: "mx_tax_del", name: "to delete" } }), "POST taxonomies (to delete)");
    denied(await app.inject({ method: "DELETE", url: "/api/taxonomies/mx_tax_del", headers: H(readTok) }), "DELETE taxonomies/:uid (read token)");
    okStatus(await app.inject({ method: "DELETE", url: "/api/taxonomies/mx_tax_del", headers: H(editTok) }), "DELETE taxonomies/:uid");
  });
});
