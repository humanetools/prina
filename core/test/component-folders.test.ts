/** Component folders (42-IMPL-component-folders): one tree, empty folders, rename, delete, moving components */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  componentCreate,
  componentDelete,
  componentList,
  componentUpdate,
} from "../src/modules/content-type/component-commands.js";
import {
  componentFolderCreate,
  componentFolderDelete,
  componentFolderRename,
  componentFolderTree,
} from "../src/modules/content-type/component-folder-commands.js";
import { ConflictError, NotFoundError, ValidationError } from "../src/lib/errors.js";
import { setupTestContext, type TestContext } from "./helpers.js";

let t: TestContext;
let other: TestContext;

const DEF = { fields: [{ name: "title", type: "text" }] };
const mk = (uid: string, folder?: string, ctx = t) =>
  componentCreate.run({ uid, name: uid, definition: DEF, ...(folder ? { folder } : {}) }, ctx.ctx);
const tree = async (ctx: TestContext = t) => {
  const res = await componentFolderTree.run({}, ctx.ctx);
  return { ...res, byPath: new Map(res.items.map((i) => [i.path, i])) };
};
const folderOf = async (uid: string) => (await componentList.run({}, t.ctx)).find((c) => c.uid === uid)!.folder;

beforeAll(async () => {
  t = await setupTestContext();
  other = await setupTestContext();
});
afterAll(async () => {
  await t.cleanup();
  await other.cleanup();
});

describe("component folders — create and tree", () => {
  it("creates an empty folder with its ancestors; the tree lists derived folders with direct counts", async () => {
    await componentFolderCreate.run({ path: "/blocks/cards/2026" }, t.ctx);
    await mk("ds.card", "/blocks");
    await mk("ds.loose");
    await mk("ds.legacy", "/legacy/old"); // a folder that exists only through its component
    const res = await tree();
    expect(res.items.map((i) => i.path)).toEqual(["/blocks", "/blocks/cards", "/blocks/cards/2026", "/legacy", "/legacy/old"]);
    expect(res.byPath.get("/blocks")).toEqual({ path: "/blocks", name: "blocks", parent: null, count: 1 });
    expect(res.byPath.get("/blocks/cards/2026")).toMatchObject({ name: "2026", parent: "/blocks/cards", count: 0 });
    expect(res.rootCount).toBe(1);
    expect(res.total).toBe(3);
    expect(await folderOf("ds.card")).toBe("/blocks");
    expect(await folderOf("ds.loose")).toBe("/");
  });

  it("refuses duplicates, bad paths and the reserved uids", async () => {
    await expect(componentFolderCreate.run({ path: "/blocks" }, t.ctx)).rejects.toBeInstanceOf(ConflictError);
    await expect(componentFolderCreate.run({ path: "blocks" }, t.ctx)).rejects.toBeInstanceOf(ValidationError);
    await expect(mk("folders")).rejects.toBeInstanceOf(ValidationError);
    await expect(mk("folder-tree")).rejects.toBeInstanceOf(ValidationError);
    await expect(mk("ds.bad", "no-slash")).rejects.toBeInstanceOf(ValidationError);
  });

  it("is isolated per workspace", async () => {
    expect((await tree(other)).items).toEqual([]);
    await mk("ds.other", "/elsewhere", other);
    expect((await tree(other)).items.map((i) => i.path)).toEqual(["/elsewhere"]);
    expect((await tree()).byPath.has("/elsewhere")).toBe(false);
  });
});

describe("component folders — rename, move, delete", () => {
  it("rename rewrites the subtree and the components inside; refuses a taken target and its own subtree", async () => {
    const out = await componentFolderRename.run({ path: "/blocks", newPath: "/design/blocks" }, t.ctx);
    expect(out).toMatchObject({ path: "/design/blocks", previousPath: "/blocks", movedComponents: 1 });
    const res = await tree();
    expect(res.items.map((i) => i.path)).toEqual(["/design", "/design/blocks", "/design/blocks/cards", "/design/blocks/cards/2026", "/legacy", "/legacy/old"]);
    expect(await folderOf("ds.card")).toBe("/design/blocks");
    await expect(componentFolderRename.run({ path: "/design/blocks", newPath: "/legacy" }, t.ctx)).rejects.toBeInstanceOf(ConflictError);
    await expect(componentFolderRename.run({ path: "/design", newPath: "/design/blocks/x" }, t.ctx)).rejects.toBeInstanceOf(ValidationError);
    await expect(componentFolderRename.run({ path: "/nope", newPath: "/x" }, t.ctx)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("moving a component registers the folder it leaves and the one it enters", async () => {
    await componentUpdate.run({ uid: "ds.card", folder: "/design/blocks/cards" }, t.ctx);
    expect(await folderOf("ds.card")).toBe("/design/blocks/cards");
    const res = await tree();
    expect(res.byPath.get("/design/blocks")).toMatchObject({ count: 0 }); // still listed
    expect(res.byPath.get("/design/blocks/cards")).toMatchObject({ count: 1 });
    // an unrelated update (name only) leaves the folder alone
    await componentUpdate.run({ uid: "ds.card", name: "Card!" }, t.ctx);
    expect(await folderOf("ds.card")).toBe("/design/blocks/cards");
  });

  it("delete refuses a folder that holds components (anywhere under it) and removes empty subtrees", async () => {
    await expect(componentFolderDelete.run({ path: "/design" }, t.ctx)).rejects.toBeInstanceOf(ConflictError);
    const removed = await componentFolderDelete.run({ path: "/design/blocks/cards/2026" }, t.ctx);
    expect(removed.removed).toEqual(["/design/blocks/cards/2026"]);
    await expect(componentFolderDelete.run({ path: "/nothing" }, t.ctx)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("a folder survives the deletion of its last component", async () => {
    await componentDelete.run({ uid: "ds.legacy" }, t.ctx);
    const res = await tree();
    expect(res.byPath.get("/legacy/old")).toMatchObject({ count: 0 });
    await componentFolderDelete.run({ path: "/legacy" }, t.ctx);
    expect((await tree()).byPath.has("/legacy")).toBe(false);
  });
});
