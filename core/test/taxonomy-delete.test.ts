/** Deleting a taxonomy (29-IMPL): the tree and its attachments go, entries and assets stay */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assetConfirmUpload, assetGet, assetRequestUpload } from "../src/modules/asset/commands.js";
import { assetSetTaxonomies } from "../src/modules/asset/taxonomy-commands.js";
import { contentTypeCreate } from "../src/modules/content-type/commands.js";
import { entryCreate, entryGet } from "../src/modules/entry/commands.js";
import { entrySetTaxonomies } from "../src/modules/entry/document-commands.js";
import { taxonomyCreate, taxonomyDelete, taxonomyList, taxonomyNodeCreate, taxonomyTree } from "../src/modules/taxonomy/commands.js";
import { NotFoundError } from "../src/lib/errors.js";
import { setupTestContext, type TestContext } from "./helpers.js";

let t: TestContext;
let other: TestContext;
beforeAll(async () => {
  t = await setupTestContext();
  other = await setupTestContext();
});
afterAll(async () => {
  await t.cleanup();
  await other.cleanup();
});

const node = async (ctx: TestContext, taxonomyUid: string, name: string, slug: string, parentId: string | null = null) =>
  (await taxonomyNodeCreate.run({ taxonomyUid, name, slug, parentId, entryComponentUid: null }, ctx.ctx)).id;

describe("taxonomy.delete", () => {
  it("removes the taxonomy, its nodes and every attachment — and reports what went; entries and assets stay", async () => {
    await contentTypeCreate.run({ uid: "td_item", name: "Item", definition: { fields: [{ name: "title", type: "text" }] } }, t.ctx);
    await taxonomyCreate.run({ uid: "td_gone", name: "Going away" }, t.ctx);
    await taxonomyCreate.run({ uid: "td_stays", name: "Staying" }, t.ctx);
    const root = await node(t, "td_gone", "Root", "root");
    const child = await node(t, "td_gone", "Child", "child", root);
    const kept = await node(t, "td_stays", "Kept", "kept");

    const { entry } = await entryCreate.run({ typeUid: "td_item", values: { title: "e" } }, t.ctx);
    await entrySetTaxonomies.run({ typeUid: "td_item", id: entry.id, attachments: [{ nodeId: child }, { nodeId: kept }] }, t.ctx);
    const { asset } = await assetRequestUpload.run({ filename: "a.txt", mime: "text/plain", size: 1, folder: "/" }, t.ctx);
    await t.services.storage.adapter.put(asset.storageKey, Buffer.from("x"), "text/plain");
    await assetConfirmUpload.run({ id: asset.id }, t.ctx);
    await assetSetTaxonomies.run({ id: asset.id, nodeIds: [root, child] }, t.ctx);

    const res = await taxonomyDelete.run({ uid: "td_gone" }, t.ctx);
    expect(res).toMatchObject({ uid: "td_gone", name: "Going away", nodes: 2, entryAttachments: 1, assetAttachments: 2 });

    expect((await taxonomyList.run({}, t.ctx)).map((x) => x.uid)).toEqual(["td_stays"]);
    await expect(taxonomyTree.run({ taxonomyUid: "td_gone" }, t.ctx)).rejects.toBeInstanceOf(NotFoundError);
    expect((await entryGet.run({ typeUid: "td_item", id: entry.id }, t.ctx)).taxonomies.map((x) => x.nodeId)).toEqual([kept]);
    expect((await assetGet.run({ id: asset.id }, t.ctx)).taxonomies).toEqual([]);
    // the uid is free again
    await taxonomyCreate.run({ uid: "td_gone", name: "Again" }, t.ctx);
  });

  it("answers 404 for an unknown uid and never reaches another workspace's taxonomy", async () => {
    await expect(taxonomyDelete.run({ uid: "td_never" }, t.ctx)).rejects.toBeInstanceOf(NotFoundError);
    await taxonomyCreate.run({ uid: "td_theirs", name: "Theirs" }, other.ctx);
    await expect(taxonomyDelete.run({ uid: "td_theirs" }, t.ctx)).rejects.toBeInstanceOf(NotFoundError);
    expect((await taxonomyList.run({}, other.ctx)).map((x) => x.uid)).toContain("td_theirs");
  });
});
