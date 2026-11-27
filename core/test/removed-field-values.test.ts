/**
 * Removing a field from a content type must not wedge its entries (2026-11-03, hikrobot site_assets):
 * the stored values still carry the old key, and every later update merges it back in, so the schema
 * (additionalProperties: false) rejected all saves.
 *
 * Since 56-IMPL the leftover value is neither judged nor thrown away behind the editor's back: saves go
 * through with it still stored, the entry lists it (`removedFields`), and it is deleted when the removal
 * is confirmed (`dropRemovedFields`). Unknown keys in the caller's input are still rejected.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contentTypeCreate, contentTypeUpdate } from "../src/modules/content-type/commands.js";
import { entryCreate, entryGet, entryUpdate } from "../src/modules/entry/commands.js";
import { setupTestContext, type TestContext } from "./helpers.js";

let t: TestContext;
let id = "";

beforeAll(async () => {
  t = await setupTestContext();
  await contentTypeCreate.run(
    { uid: "rf_site", name: "Site", kind: "single", definition: { displayField: "title", fields: [
      { name: "title", type: "text", required: true },
      { name: "keep_css", type: "text", multiline: true },
      { name: "old_css", type: "text", multiline: true },
    ] } },
    t.ctx,
  );
  const { entry } = await entryCreate.run({ typeUid: "rf_site", values: { title: "Site", keep_css: "a{}", old_css: "b{}" } }, t.ctx);
  id = entry.id;
  // drop old_css from the type — the entry still has the key in its stored values
  await contentTypeUpdate.run(
    { uid: "rf_site", name: "Site", definition: { displayField: "title", fields: [
      { name: "title", type: "text", required: true },
      { name: "keep_css", type: "text", multiline: true },
    ] } },
    t.ctx,
  );
});
afterAll(async () => {
  await t.cleanup();
});

describe("values of a removed field", () => {
  it("do not fail a save when the caller echoes the stale key back (admin form round-trip)", async () => {
    const saved = await entryUpdate.run({ typeUid: "rf_site", id, values: { keep_css: "a{}", old_css: "b{}" } }, t.ctx);
    expect(saved.entry.values).toMatchObject({ keep_css: "a{}" });
  });

  it("do not fail the next save, stay stored, and are listed on the entry", async () => {
    const saved = await entryUpdate.run({ typeUid: "rf_site", id, values: { keep_css: "a{color:red}" } }, t.ctx);
    expect(saved.entry.values).toMatchObject({ title: "Site", keep_css: "a{color:red}", old_css: "b{}" });
    const again = await entryGet.run({ typeUid: "rf_site", id }, t.ctx);
    expect(again.removedFields).toEqual([{ path: "old_css", value: "b{}" }]);
  });

  it("are deleted once the removal is confirmed", async () => {
    const saved = await entryUpdate.run({ typeUid: "rf_site", id, dropRemovedFields: true }, t.ctx);
    expect("old_css" in saved.entry.values).toBe(false);
    expect(saved.entry.values).toMatchObject({ title: "Site", keep_css: "a{color:red}" });
    expect((await entryGet.run({ typeUid: "rf_site", id }, t.ctx)).removedFields).toEqual([]);
  });

  it("still rejects a key that never existed in the type", async () => {
    await expect(entryUpdate.run({ typeUid: "rf_site", id, values: { bogus: 1 } }, t.ctx)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});
