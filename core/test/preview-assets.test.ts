/**
 * 43-IMPL preview assets — the admin previews inline single-type text fields (site CSS) listed in
 * settings.previewAssets: latest saved value (drafts included), default locale first, malformed or
 * missing references reported as `missing`, no setting → [].
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ContentTypeKind } from "@prina/shared";
import { contentTypeCreate } from "../src/modules/content-type/commands.js";
import { componentCreate } from "../src/modules/content-type/component-commands.js";
import { entryCreate, entryUpdate } from "../src/modules/entry/commands.js";
import { templateRenderPreview, templateSave } from "../src/modules/template/commands.js";
import { partialRender, partialSave } from "../src/modules/template/partial-commands.js";
import { workspaceUpdateSettings } from "../src/modules/workspace/commands.js";
import { loadPreviewAssets } from "../src/modules/template/preview-assets.js";
import { publishEntry, setupTestContext, type TestContext } from "./helpers.js";

let t: TestContext;
let pageId: string;
let assetsEntryId: string;

beforeAll(async () => {
  t = await setupTestContext();
  await contentTypeCreate.run(
    {
      uid: "site_assets",
      name: "Site assets",
      kind: ContentTypeKind.Single,
      definition: {
        fields: [
          { name: "tokens_css", type: "text", multiline: true },
          { name: "icons_svg", type: "text", multiline: true },
          { name: "count", type: "number" },
        ],
      },
    },
    t.ctx,
  );
  const a = await entryCreate.run(
    { typeUid: "site_assets", values: { tokens_css: ":root{--brand:#123}", icons_svg: "<svg><symbol id='i'/></svg>", count: 1 } },
    t.ctx,
  );
  assetsEntryId = a.entry.id;
  await publishEntry(t.ctx, "site_assets", assetsEntryId);

  await componentCreate.run(
    { uid: "ds.card", name: "Card", options: { markup: true }, definition: { fields: [{ name: "title", type: "text" }] } },
    t.ctx,
  );
  await partialSave.run({ name: "ds.card", liquid: "<b>{{ blk.title }}</b>" }, t.ctx);
  await contentTypeCreate.run(
    { uid: "page", name: "Page", definition: { fields: [{ name: "title", type: "text", required: true }], displayField: "title" } },
    t.ctx,
  );
  await templateSave.run({ typeUid: "page", liquid: "<h1>{{ values.title }}</h1>", css: "h1{color:red}" }, t.ctx);
  const p = await entryCreate.run({ typeUid: "page", values: { title: "Hi" } }, t.ctx);
  pageId = p.entry.id;
});

afterAll(async () => {
  await t.cleanup();
});

describe("43-IMPL — preview assets", () => {
  it("returns [] while nothing is configured", async () => {
    expect(await loadPreviewAssets(t.ctx)).toEqual([]);
    const out = await templateRenderPreview.run({ typeUid: "page", entryId: pageId }, t.ctx);
    expect(out.assets).toEqual([]);
    expect((await partialRender.run({ name: "ds.card", values: { title: "x" } }, t.ctx)).assets).toEqual([]);
  });

  it("inlines the configured fields into both preview responses, in order, with the latest saved (draft) text", async () => {
    await workspaceUpdateSettings.run(
      {
        settings: {
          previewAssets: [
            { type: "site_assets", field: "tokens_css" },
            { type: "site_assets", field: "icons_svg", as: "svg" },
            { type: "site_assets", field: "count" }, // a number field → missing
            { type: "nope", field: "x" }, // unknown type → missing
            { bad: true }, // malformed → dropped
          ],
        },
      },
      t.ctx,
    );
    const out = await templateRenderPreview.run({ typeUid: "page", entryId: pageId }, t.ctx);
    expect(out.assets).toEqual([
      { type: "site_assets", field: "tokens_css", as: "css", body: ":root{--brand:#123}" },
      { type: "site_assets", field: "icons_svg", as: "svg", body: "<svg><symbol id='i'/></svg>" },
      { type: "site_assets", field: "count", as: "css", body: "", missing: true },
      { type: "nope", field: "x", as: "css", body: "", missing: true },
    ]);
    expect(out.css).toBe("h1{color:red}"); // the template's own css is unchanged — assets ride separately

    // editing the CSS entry (draft, unpublished) shows up immediately
    await entryUpdate.run(
      { typeUid: "site_assets", id: assetsEntryId, values: { tokens_css: ":root{--brand:#456}", icons_svg: "<svg/>", count: 1 } },
      t.ctx,
    );
    const partial = await partialRender.run({ name: "ds.card", values: { title: "x" } }, t.ctx);
    expect(partial.assets[0]).toMatchObject({ field: "tokens_css", body: ":root{--brand:#456}" });
    expect(partial.html).toBe("<b>x</b>");
  });
});
