/** Content-type folders (38-IMPL-content-type-folders): per-kind trees, empty folders, rename, delete, moving types */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ContentTypeKind } from "@prina/shared";
import { contentTypeCreate, contentTypeDelete, contentTypeList, contentTypeUpdate } from "../src/modules/content-type/commands.js";
import {
  contentTypeFolderCreate,
  contentTypeFolderDelete,
  contentTypeFolderRename,
  contentTypeFolderTree,
} from "../src/modules/content-type/folder-commands.js";
import { ConflictError, NotFoundError, ValidationError } from "../src/lib/errors.js";
import { setupTestContext, type TestContext } from "./helpers.js";
import { articleDefinition } from "./fixtures.js";

let t: TestContext;
let other: TestContext;
const C = ContentTypeKind.Collection;
const S = ContentTypeKind.Single;

const mkType = (uid: string, folder?: string, kind: ContentTypeKind = C, ctx = t) =>
  contentTypeCreate.run({ uid, name: uid, kind, definition: articleDefinition, ...(folder ? { folder } : {}) }, ctx.ctx);
const tree = async (kind: ContentTypeKind = C, ctx: TestContext = t) => {
  const res = await contentTypeFolderTree.run({ kind }, ctx.ctx);
  return { ...res, byPath: new Map(res.items.map((i) => [i.path, i])) };
};
const folderOf = async (uid: string) => (await contentTypeList.run({}, t.ctx)).find((c) => c.uid === uid)!.folder;

beforeAll(async () => {
  t = await setupTestContext();
  other = await setupTestContext();
});
afterAll(async () => {
  await t.cleanup();
  await other.cleanup();
});

describe("content-type folders — create and tree", () => {
  it("creates an empty folder with its ancestors; the tree lists derived folders with direct counts", async () => {
    await contentTypeFolderCreate.run({ kind: C, path: "/shop/catalog/2026" }, t.ctx);
    await mkType("product", "/shop");
    await mkType("loose");
    await mkType("legacy_post", "/legacy_blog/posts"); // a folder that exists only through its type
    const res = await tree();
    expect(res.items.map((i) => i.path)).toEqual(["/legacy_blog", "/legacy_blog/posts", "/shop", "/shop/catalog", "/shop/catalog/2026"]);
    expect(res.byPath.get("/shop")).toEqual({ path: "/shop", name: "shop", parent: null, count: 1 });
    expect(res.byPath.get("/shop/catalog/2026")).toMatchObject({ name: "2026", parent: "/shop/catalog", count: 0 });
    expect(res.byPath.get("/legacy_blog")).toMatchObject({ count: 0 });
    expect(res.rootCount).toBe(1);
    expect(res.total).toBe(3);
    expect(await folderOf("product")).toBe("/shop");
    expect(await folderOf("loose")).toBe("/");
  });

  it("keeps a separate tree per kind", async () => {
    await mkType("homepage", "/pages", S);
    expect((await tree(S)).items.map((i) => i.path)).toEqual(["/pages"]);
    expect((await tree(C)).byPath.has("/pages")).toBe(false);
    // the same path can be created in the other kind's tree — it is a different folder
    await contentTypeFolderCreate.run({ kind: S, path: "/shop" }, t.ctx);
    expect((await tree(S)).byPath.get("/shop")).toMatchObject({ count: 0 });
    expect((await tree(C)).byPath.get("/shop")).toMatchObject({ count: 1 });
  });

  it("refuses duplicates (explicit or type-derived), the root, and malformed paths", async () => {
    await expect(contentTypeFolderCreate.run({ kind: C, path: "/shop/catalog" }, t.ctx)).rejects.toBeInstanceOf(ConflictError);
    await expect(contentTypeFolderCreate.run({ kind: C, path: "/legacy_blog" }, t.ctx)).rejects.toBeInstanceOf(ConflictError);
    for (const path of ["/", "no-slash", "/a//b", "/trailing/", "/bad*name", "/ padded"]) {
      await expect(contentTypeFolderCreate.run({ kind: C, path }, t.ctx), path).rejects.toBeInstanceOf(ValidationError);
    }
    await expect(mkType("bad_folder", "no-slash")).rejects.toBeInstanceOf(ValidationError);
  });

  it("refuses the uids the folder routes occupy", async () => {
    await expect(mkType("folders")).rejects.toBeInstanceOf(ValidationError);
    await expect(mkType("folder-tree")).rejects.toBeInstanceOf(ValidationError);
  });

  it("is scoped to the workspace", async () => {
    expect((await tree(C, other)).items).toEqual([]);
    await contentTypeFolderCreate.run({ kind: C, path: "/shop" }, other.ctx); // same path elsewhere is not a conflict
    await expect(contentTypeFolderDelete.run({ kind: C, path: "/shop/catalog" }, other.ctx)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("content-type folders — moving types", () => {
  it("moves a type with content_type.update; the folder it left stays, the target is created on demand", async () => {
    await mkType("mover", "/inbox_only");
    const moved = await contentTypeUpdate.run({ uid: "mover", folder: "/shop/catalog/summer" }, t.ctx);
    expect(moved.folder).toBe("/shop/catalog/summer");
    const res = await tree();
    expect(res.byPath.get("/inbox_only")).toMatchObject({ count: 0 }); // registered when the type left
    expect(res.byPath.get("/shop/catalog/summer")).toMatchObject({ count: 1 });
  });

  it("moves back to the root with `/` and leaves the version untouched", async () => {
    const before = (await contentTypeList.run({}, t.ctx)).find((c) => c.uid === "mover")!;
    const moved = await contentTypeUpdate.run({ uid: "mover", folder: "/" }, t.ctx);
    expect(moved.folder).toBe("/");
    expect(moved.version).toBe(before.version);
    expect((await tree()).rootCount).toBe(2);
  });

  it("keeps the folder of a deleted type", async () => {
    await mkType("ephemeral", "/short_lived");
    await contentTypeDelete.run({ uid: "ephemeral" }, t.ctx);
    expect((await tree()).byPath.get("/short_lived")).toMatchObject({ count: 0 });
  });
});

describe("content-type folders — rename", () => {
  it("rewrites the folder, its subfolders and the types inside; only within its kind", async () => {
    await mkType("deep", "/shop/catalog/2026");
    const res = await contentTypeFolderRename.run({ kind: C, path: "/shop", newPath: "/store" }, t.ctx);
    expect(res).toEqual({ kind: C, path: "/store", previousPath: "/shop", movedTypes: 2 });
    const after = await tree();
    expect(after.byPath.has("/shop")).toBe(false);
    expect(after.items.filter((i) => i.path.startsWith("/store")).map((i) => i.path)).toEqual([
      "/store", "/store/catalog", "/store/catalog/2026", "/store/catalog/summer",
    ]);
    expect(await folderOf("product")).toBe("/store");
    expect(await folderOf("deep")).toBe("/store/catalog/2026");
    expect((await tree(S)).byPath.has("/shop")).toBe(true); // the single-type tree is untouched
  });

  it("does not touch look-alike prefixes (no LIKE) and refuses conflicts, self-moves and unknown folders", async () => {
    await mkType("rn_a_type", "/rn_a");
    await mkType("rnxa_type", "/rnXa");
    await contentTypeFolderRename.run({ kind: C, path: "/rn_a", newPath: "/rn_b" }, t.ctx);
    expect(await folderOf("rnxa_type")).toBe("/rnXa");
    expect(await folderOf("rn_a_type")).toBe("/rn_b");
    await expect(contentTypeFolderRename.run({ kind: C, path: "/rn_b", newPath: "/store" }, t.ctx)).rejects.toBeInstanceOf(ConflictError);
    await expect(contentTypeFolderRename.run({ kind: C, path: "/rn_b", newPath: "/rn_b/inner" }, t.ctx)).rejects.toBeInstanceOf(ValidationError);
    await expect(contentTypeFolderRename.run({ kind: C, path: "/rn_b", newPath: "/rn_b" }, t.ctx)).rejects.toBeInstanceOf(ValidationError);
    await expect(contentTypeFolderRename.run({ kind: C, path: "/nope", newPath: "/x" }, t.ctx)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("content-type folders — delete", () => {
  it("refuses while a type sits in the folder or under it", async () => {
    await expect(contentTypeFolderDelete.run({ kind: C, path: "/store" }, t.ctx)).rejects.toBeInstanceOf(ConflictError);
    await expect(contentTypeFolderDelete.run({ kind: C, path: "/store/catalog" }, t.ctx)).rejects.toBeInstanceOf(ConflictError);
  });

  it("removes an empty folder together with its empty subfolders", async () => {
    await contentTypeFolderCreate.run({ kind: C, path: "/tmp_tree/a/b" }, t.ctx);
    const res = await contentTypeFolderDelete.run({ kind: C, path: "/tmp_tree" }, t.ctx);
    expect(res.removed).toEqual(["/tmp_tree", "/tmp_tree/a", "/tmp_tree/a/b"]);
    expect((await tree()).byPath.has("/tmp_tree")).toBe(false);
    await expect(contentTypeFolderDelete.run({ kind: C, path: "/tmp_tree" }, t.ctx)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("a folder known only through an ancestor chain can be deleted once registered", async () => {
    // /legacy_blog exists only because legacy_post sits in /legacy_blog/posts — moving the type out registers both
    await contentTypeUpdate.run({ uid: "legacy_post", folder: "/" }, t.ctx);
    const res = await contentTypeFolderDelete.run({ kind: C, path: "/legacy_blog" }, t.ctx);
    expect(res.removed).toEqual(["/legacy_blog", "/legacy_blog/posts"]);
  });
});
