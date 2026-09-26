/** DAM folder tree (24-IMPL-dam-folder-tree): empty folders, subfolders, rename, delete, moving assets */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { ApiGrantItem, ApiGrantLevel, McpPlane } from "@prina/shared";
import { buildApp } from "../src/app.js";
import { createDb } from "../src/db/client.js";
import { assetConfirmUpload, assetDelete, assetFolders, assetGet, assetList, assetRequestUpload, assetUpdate } from "../src/modules/asset/commands.js";
import { assetFolderCreate, assetFolderDelete, assetFolderRename, assetFolderTree } from "../src/modules/asset/folder-commands.js";
import { mcpTokenCreate } from "../src/modules/mcp/tokens.js";
import { ConflictError, NotFoundError, ValidationError } from "../src/lib/errors.js";
import { setupTestContext, type TestContext } from "./helpers.js";

let t: TestContext;
let other: TestContext;
let app: FastifyInstance;
let token: string;
const H = () => ({ authorization: `Bearer ${token}` });

async function upload(ctx: TestContext, filename: string, folder = "/"): Promise<string> {
  const { asset } = await assetRequestUpload.run({ filename, mime: "text/plain", size: 5, folder }, ctx.ctx);
  await ctx.services.storage.adapter.put(asset.storageKey, Buffer.from("hello"), "text/plain");
  return (await assetConfirmUpload.run({ id: asset.id }, ctx.ctx)).id;
}
const tree = async (ctx: TestContext = t) => {
  const res = await assetFolderTree.run({}, ctx.ctx);
  return { ...res, byPath: new Map(res.items.map((i) => [i.path, i])) };
};

beforeAll(async () => {
  t = await setupTestContext();
  other = await setupTestContext();
  const { db } = createDb(process.env.TEST_DATABASE_URL!);
  app = buildApp({ env: { LOG_LEVEL: "error", NODE_ENV: "test", ADMIN_DIST_PATH: undefined, S3_REGION: "us-east-1" }, db, services: t.services });
  token = (await mcpTokenCreate.run({ name: "af-assets", plane: McpPlane.Management, grants: [{ item: ApiGrantItem.Assets, level: ApiGrantLevel.Edit }] }, t.ctx)).token;
});
afterAll(async () => {
  await app.close();
  await t.cleanup();
  await other.cleanup();
});

describe("asset folders — create and tree", () => {
  it("creates an empty folder and its missing ancestors; the tree is path-ordered with parents and direct counts", async () => {
    await assetFolderCreate.run({ path: "/brand/2026/spring" }, t.ctx);
    await upload(t, "logo.txt", "/brand");
    await upload(t, "loose.txt");
    await upload(t, "legacy.txt", "/legacy_shots/raw"); // a folder that exists only through its asset
    const res = await tree();
    expect(res.items.map((i) => i.path)).toEqual(["/brand", "/brand/2026", "/brand/2026/spring", "/legacy_shots", "/legacy_shots/raw"]);
    expect(res.byPath.get("/brand")).toEqual({ path: "/brand", name: "brand", parent: null, count: 1 });
    expect(res.byPath.get("/brand/2026/spring")).toMatchObject({ name: "spring", parent: "/brand/2026", count: 0 });
    expect(res.byPath.get("/legacy_shots")).toMatchObject({ count: 0 });
    expect(res.rootCount).toBe(1);
    expect(res.total).toBe(3);
  });

  it("keeps the plain folder list a string array, now with empty folders and ancestors", async () => {
    const list = await assetFolders.run({}, t.ctx);
    expect(list).toEqual(["/", "/brand", "/brand/2026", "/brand/2026/spring", "/legacy_shots", "/legacy_shots/raw"]);
  });

  it("refuses duplicates (explicit or asset-derived), the root, and malformed paths", async () => {
    await expect(assetFolderCreate.run({ path: "/brand/2026" }, t.ctx)).rejects.toBeInstanceOf(ConflictError);
    await expect(assetFolderCreate.run({ path: "/legacy_shots" }, t.ctx)).rejects.toBeInstanceOf(ConflictError);
    for (const path of ["/", "no-slash", "/a//b", "/trailing/", "/bad*name", "/ padded"]) {
      await expect(assetFolderCreate.run({ path }, t.ctx), path).rejects.toBeInstanceOf(ValidationError);
    }
  });

  it("is scoped to the workspace", async () => {
    expect((await tree(other)).items).toEqual([]);
    await assetFolderCreate.run({ path: "/brand" }, other.ctx); // same path elsewhere is not a conflict
    await expect(assetFolderDelete.run({ path: "/brand/2026" }, other.ctx)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("asset folders — moving assets", () => {
  it("moves an asset with asset.update; the folder it left stays in the tree, the target is created on demand", async () => {
    const id = await upload(t, "mover.txt", "/inbox_only");
    const moved = await assetUpdate.run({ id, folder: "/brand/2026/summer" }, t.ctx);
    expect(moved.folder).toBe("/brand/2026/summer");
    expect(moved.alt).toBeNull(); // alt untouched when not sent
    const res = await tree();
    expect(res.byPath.get("/inbox_only")).toMatchObject({ count: 0 });
    expect(res.byPath.get("/brand/2026/summer")).toMatchObject({ count: 1 });
    expect((await assetList.run({ folder: "/brand/2026/summer" }, t.ctx)).items.map((a) => a.id)).toEqual([id]);

    await assetUpdate.run({ id, alt: "described" }, t.ctx);
    expect((await assetGet.run({ id }, t.ctx)).folder).toBe("/brand/2026/summer");
    await expect(assetUpdate.run({ id }, t.ctx)).rejects.toBeInstanceOf(ValidationError);
    await expect(assetUpdate.run({ id, folder: "bad" }, t.ctx)).rejects.toBeInstanceOf(ValidationError);
  });

  it("keeps a folder whose last asset was deleted", async () => {
    const id = await upload(t, "gone.txt", "/short_lived");
    await assetDelete.run({ id }, t.ctx);
    expect((await tree()).byPath.get("/short_lived")).toMatchObject({ count: 0 });
  });
});

describe("asset folders — rename", () => {
  it("rewrites the folder, its subfolders and the assets inside; `_` in names is not a wildcard", async () => {
    await assetFolderCreate.run({ path: "/rn_a/deep/er" }, t.ctx);
    await assetFolderCreate.run({ path: "/rnXa" }, t.ctx); // would match `/rn_a` under LIKE
    const inside = await upload(t, "inside.txt", "/rn_a/deep");
    const bystander = await upload(t, "bystander.txt", "/rnXa");
    const res = await assetFolderRename.run({ path: "/rn_a", newPath: "/renamed" }, t.ctx);
    expect(res).toEqual({ path: "/renamed", previousPath: "/rn_a", movedAssets: 1 });
    const paths = (await tree()).items.map((i) => i.path);
    expect(paths).toEqual(expect.arrayContaining(["/renamed", "/renamed/deep", "/renamed/deep/er", "/rnXa"]));
    expect(paths.some((p) => p.startsWith("/rn_a"))).toBe(false);
    expect((await assetGet.run({ id: inside }, t.ctx)).folder).toBe("/renamed/deep");
    expect((await assetGet.run({ id: bystander }, t.ctx)).folder).toBe("/rnXa");
  });

  it("moves a folder under another one, and registers a folder that only existed through assets", async () => {
    await upload(t, "implicit.txt", "/implicit_src");
    await assetFolderRename.run({ path: "/implicit_src", newPath: "/renamed/moved_in" }, t.ctx);
    expect((await tree()).byPath.get("/renamed/moved_in")).toMatchObject({ parent: "/renamed", count: 1 });
  });

  it("answers 404 for an unknown folder, 409 for an existing target, 422 for itself or its own subtree", async () => {
    await expect(assetFolderRename.run({ path: "/nope", newPath: "/nope2" }, t.ctx)).rejects.toBeInstanceOf(NotFoundError);
    await expect(assetFolderRename.run({ path: "/renamed", newPath: "/brand" }, t.ctx)).rejects.toBeInstanceOf(ConflictError);
    await expect(assetFolderRename.run({ path: "/renamed", newPath: "/renamed" }, t.ctx)).rejects.toBeInstanceOf(ValidationError);
    await expect(assetFolderRename.run({ path: "/renamed", newPath: "/renamed/deep/inside" }, t.ctx)).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("asset folders — delete", () => {
  it("refuses while assets sit in the folder or under it, then removes the folder with its empty subfolders", async () => {
    await assetFolderCreate.run({ path: "/del/sub/leaf" }, t.ctx);
    const id = await upload(t, "blocker.txt", "/del/sub");
    await expect(assetFolderDelete.run({ path: "/del" }, t.ctx)).rejects.toBeInstanceOf(ConflictError);
    await assetDelete.run({ id }, t.ctx);
    const res = await assetFolderDelete.run({ path: "/del" }, t.ctx);
    expect(res.removed).toEqual(["/del", "/del/sub", "/del/sub/leaf"]);
    expect((await tree()).items.some((i) => i.path.startsWith("/del"))).toBe(false);
    await expect(assetFolderDelete.run({ path: "/del" }, t.ctx)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("asset folders — HTTP", () => {
  it("serves the tree and runs create / rename / delete / move through the routes", async () => {
    const created = await app.inject({ method: "POST", url: "/api/assets/folders", headers: H(), payload: { path: "/http/one" } });
    expect(created.statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: "/api/assets/folders", headers: H(), payload: { path: "/http/one" } })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: "/api/assets/folders", headers: H(), payload: { path: "one" } })).statusCode).toBe(422);

    const renamed = await app.inject({ method: "PATCH", url: "/api/assets/folders", headers: H(), payload: { path: "/http/one", newPath: "/http/two" } });
    expect(renamed.statusCode).toBe(200);
    const id = await upload(t, "via-http.txt");
    const moved = await app.inject({ method: "PATCH", url: `/api/assets/${id}`, headers: H(), payload: { folder: "/http/two" } });
    expect(moved.json().folder).toBe("/http/two");

    const got = await app.inject({ method: "GET", url: "/api/assets/folder-tree", headers: H() });
    expect(got.statusCode).toBe(200);
    expect(got.json().items.find((i: { path: string }) => i.path === "/http/two")).toMatchObject({ name: "two", parent: "/http", count: 1 });
    expect((await app.inject({ method: "GET", url: "/api/assets/folders", headers: H() })).json()).toContain("/http/two");

    expect((await app.inject({ method: "DELETE", url: `/api/assets/folders?path=${encodeURIComponent("/http")}`, headers: H() })).statusCode).toBe(409);
    await assetDelete.run({ id }, t.ctx);
    expect((await app.inject({ method: "DELETE", url: `/api/assets/folders?path=${encodeURIComponent("/http")}`, headers: H() })).statusCode).toBe(200);
  });
});

describe("local raw serving", () => {
  it("answers with the asset's content type for passive media (SVG renders in <img>), sandboxed; other types download", async () => {
    if (t.services.storage.adapter.kind !== "local") return;
    const put = async (filename: string, mime: string, body: string) => {
      const { asset } = await assetRequestUpload.run({ filename, mime, size: body.length, folder: "/" }, t.ctx);
      await t.services.storage.adapter.put(asset.storageKey, Buffer.from(body), mime);
      await assetConfirmUpload.run({ id: asset.id }, t.ctx);
      return app.inject({ method: "GET", url: `/api/assets/raw/${encodeURIComponent(asset.storageKey)}`, headers: H() });
    };
    const svg = await put("mark.svg", "image/svg+xml", '<svg xmlns="http://www.w3.org/2000/svg"/>');
    expect(svg.statusCode).toBe(200);
    expect(svg.headers["content-type"]).toContain("image/svg+xml");
    expect(svg.headers["content-security-policy"]).toContain("sandbox");
    expect(svg.headers["x-content-type-options"]).toBe("nosniff");
    const html = await put("page.html", "text/html", "<script>1</script>");
    expect(html.headers["content-type"]).toContain("application/octet-stream");
  });
});
