/** §0.12 two-level alt: {id, alt} media value shape, populate merge, advisories, analysis */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toMediaRef, toMediaRefs } from "../src/content/field-types/media.js";
import { tryAnalyzeImage } from "../src/modules/asset/analysis.js";
import {
  assetAnalyze,
  assetConfirmUpload,
  assetGet,
  assetRequestUpload,
  assetUpdate,
} from "../src/modules/asset/commands.js";
import { contentTypeCreate } from "../src/modules/content-type/commands.js";
import { entryCreate, entryGet, entryUpdate } from "../src/modules/entry/commands.js";
import { computeAltAdvisories } from "../src/modules/entry/advisories.js";
import { populateValuesList } from "../src/modules/delivery/populate.js";
import { renderLiquid } from "../src/delivery/liquid.js";
import { setupTestContext, type TestContext } from "./helpers.js";

let t: TestContext;
let describedId: string; // asset with alt
let bareId: string; // asset without alt

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

async function uploadAsset(filename: string): Promise<string> {
  const { asset } = await assetRequestUpload.run(
    { filename, mime: "image/png", size: TINY_PNG.length, folder: "/m" },
    t.ctx,
  );
  await t.services.storage.adapter.put(asset.storageKey, TINY_PNG, "image/png");
  const confirmed = await assetConfirmUpload.run({ id: asset.id }, t.ctx);
  return confirmed.id;
}

beforeAll(async () => {
  t = await setupTestContext();
  describedId = await uploadAsset("described.png");
  await assetUpdate.run({ id: describedId, alt: "Asset-level alt" }, t.ctx);
  bareId = await uploadAsset("bare.png");
  await contentTypeCreate.run(
    {
      uid: "card",
      name: "Card",
      definition: {
        fields: [
          { name: "title", type: "text" },
          { name: "cover", type: "media", altText: true },
          { name: "gallery", type: "media", multiple: true, altText: true },
        ],
        displayField: "title",
      },
    },
    t.ctx,
  );
});

afterAll(async () => {
  await t.cleanup();
});

describe("value-shape normalization", () => {
  it("toMediaRef accepts both shapes and rejects garbage", () => {
    expect(toMediaRef("abc")).toEqual({ id: "abc", alt: undefined });
    expect(toMediaRef({ id: "abc", alt: "x" })).toEqual({ id: "abc", alt: "x" });
    expect(toMediaRef({ id: "abc" })).toEqual({ id: "abc", alt: undefined });
    expect(toMediaRef("")).toBeNull();
    expect(toMediaRef(42)).toBeNull();
    expect(toMediaRef({ alt: "no id" })).toBeNull();
  });

  it("toMediaRefs handles single/multiple and mixed arrays", () => {
    expect(toMediaRefs({ multiple: true }, ["a", { id: "b", alt: "" }])).toEqual([
      { id: "a", alt: undefined },
      { id: "b", alt: "" },
    ]);
    expect(toMediaRefs({}, "a")).toEqual([{ id: "a", alt: undefined }]);
    expect(toMediaRefs({}, null)).toEqual([]);
  });
});

describe("entry save with mixed shapes", () => {
  it("validates, saves, and syncs usages for both shapes", async () => {
    const created = await entryCreate.run(
      {
        typeUid: "card",
        values: {
          title: "Mixed",
          cover: { id: describedId, alt: "Usage override" },
          gallery: [bareId, { id: describedId, alt: "" }],
        },
      },
      t.ctx,
    );
    const detail = await entryGet.run({ typeUid: "card", id: created.entry.id }, t.ctx);
    expect(detail.entry.values.cover).toEqual({ id: describedId, alt: "Usage override" });

    const asset = await assetGet.run({ id: describedId }, t.ctx);
    expect(asset.usages.map((u: { field: string }) => u.field).sort()).toEqual([
      "cover",
      "gallery",
    ]);
  });

  it("rejects unknown keys in the ref object and missing assets", async () => {
    await expect(
      entryCreate.run(
        {
          typeUid: "card",
          values: { title: "bad", cover: { id: describedId, alt: "x", extra: 1 } },
        },
        t.ctx,
      ),
    ).rejects.toThrow();
    await expect(
      entryCreate.run(
        {
          typeUid: "card",
          values: { title: "bad", cover: "00000000-0000-4000-8000-000000000000" },
        },
        t.ctx,
      ),
    ).rejects.toThrow();
  });
});

describe("populate merge (usageAlt ?? assetAlt)", () => {
  it("overrides beat asset alt; bare uuids inherit it", async () => {
    const dctx = {
      db: t.db,
      services: t.services,
      workspace: { id: t.workspaceId, slug: t.workspaceSlug, settings: {} },
      includeDraft: true,
    };
    const definition = {
      fields: [
        { name: "cover", type: "media", altText: true },
        { name: "gallery", type: "media", multiple: true, altText: true },
      ],
    };
    const [populated] = await populateValuesList(dctx as never, definition as never, [
      {
        cover: { id: describedId, alt: "Usage override" },
        gallery: [describedId, { id: describedId, alt: "" }],
      },
    ]);
    const cover = populated!.cover as { alt: string };
    expect(cover.alt).toBe("Usage override");
    const gallery = populated!.gallery as Array<{ alt: string }>;
    expect(gallery[0]!.alt).toBe("Asset-level alt"); // inherited
    expect(gallery[1]!.alt).toBe(""); // decorative override
  });
});

describe("alt advisories", () => {
  it("flags refs whose effective alt is null; overrides and described assets pass", async () => {
    const definition = {
      fields: [
        { name: "cover", type: "media", altText: true },
        { name: "extra", type: "media", altText: true },
      ],
    };
    const advisories = await computeAltAdvisories(t.db, t.workspaceId, definition as never, {
      cover: bareId, // asset alt null → flag
      extra: { id: bareId, alt: "override" }, // usage override → pass
    });
    expect(advisories).toHaveLength(1);
    expect(advisories[0]).toMatchObject({ code: "alt-missing", field: "cover" });
    expect(advisories[0]!.message).toContain("bare.png");
  });

  it("surfaces through entryGet advisories without any SEO config", async () => {
    const created = await entryCreate.run(
      { typeUid: "card", values: { title: "NoAlt", cover: bareId } },
      t.ctx,
    );
    const detail = await entryGet.run({ typeUid: "card", id: created.entry.id }, t.ctx);
    expect(detail.advisories.map((a) => a.code)).toContain("alt-missing");
    // Describing the asset clears it
    await assetUpdate.run({ id: bareId, alt: "Now described" }, t.ctx);
    const after = await entryGet.run({ typeUid: "card", id: created.entry.id }, t.ctx);
    expect(after.advisories).toEqual([]);
    await assetUpdate.run({ id: bareId, alt: null }, t.ctx); // restore for other tests
  });
});

describe("liquid filters", () => {
  it("asset_url accepts both shapes; asset_alt reads the usage override", async () => {
    const html = await renderLiquid({
      liquid:
        `<img src="{{ values.a | asset_url }}" alt="{{ values.a | asset_alt }}">` +
        `<img src="{{ values.b | asset_url }}" alt="{{ values.b | asset_alt }}">`,
      scope: {
        values: { a: "id-plain", b: { id: "id-obj", alt: "Override" } },
      } as never,
      storage: t.services.storage,
    });
    expect(html).toContain('src="/delivery/assets/id-plain" alt=""');
    expect(html).toContain('src="/delivery/assets/id-obj" alt="Override"');
  });
});

describe("image analysis (4b)", () => {
  it("confirm merges exif and analysis into metadata", async () => {
    const detail = await assetGet.run({ id: bareId }, t.ctx);
    const analysis = (detail.metadata as { analysis?: { version: number; dominant: string } })
      .analysis;
    expect(analysis?.version).toBe(1);
    expect(analysis?.dominant).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("analyze command is idempotent and recomputes", async () => {
    const first = await assetAnalyze.run({ id: bareId }, t.ctx);
    const second = await assetAnalyze.run({ id: bareId }, t.ctx);
    const a1 = (first.metadata as { analysis: { overall: { whiteContrast: number } } }).analysis;
    const a2 = (second.metadata as { analysis: { overall: { whiteContrast: number } } }).analysis;
    expect(a1.overall.whiteContrast).toBe(a2.overall.whiteContrast);
  });

  it("computes sane contrast values for a solid black image", async () => {
    const sharp = (await import("sharp")).default;
    const black = await sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .png()
      .toBuffer();
    const analysis = await tryAnalyzeImage(black);
    expect(analysis).not.toBeNull();
    // sharp's dominant is histogram-bucketed — near-black, not exactly #000000
    expect(analysis!.dominant).toMatch(/^#0[0-8]0[0-8]0[0-8]$/);
    expect(analysis!.overall.whiteContrast).toBeCloseTo(21, 0);
    expect(analysis!.overall.blackContrast).toBeCloseTo(1, 1);
    expect(analysis!.top.luminance).toBe(0);
  });
});
