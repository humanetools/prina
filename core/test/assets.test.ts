/** DAM (T4.1~T4.3): upload flow, metadata, usage tracking, delete protection */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FieldType } from "@prina/shared";
import {
  assetConfirmUpload,
  assetDelete,
  assetGet,
  assetList,
  assetRequestUpload,
  assetUpdate,
} from "../src/modules/asset/commands.js";
import { contentTypeCreate } from "../src/modules/content-type/commands.js";
import { entryCreate, entryUpdate } from "../src/modules/entry/commands.js";
import { createImgproxySigner } from "../src/storage/imgproxy.js";
import { ConflictError, ValidationError } from "../src/lib/errors.js";
import { populateValuesList } from "../src/modules/delivery/populate.js";
import { setupTestContext, type TestContext } from "./helpers.js";

// 1x1 pixel PNG
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

let t: TestContext;
beforeAll(async () => {
  t = await setupTestContext();
  await contentTypeCreate.run(
    {
      uid: "gallery",
      name: "갤러리",
      definition: {
        fields: [
          { name: "title", type: "text" },
          { name: "cover", type: "media" },
          { name: "photos", type: "media", multiple: true },
          { name: "body", type: "richtext" },
        ],
      },
    },
    t.ctx,
  );
});
afterAll(async () => t.cleanup());

async function uploadAsset(filename = "photo.png"): Promise<string> {
  const { asset, upload } = await assetRequestUpload.run(
    { filename, mime: "image/png", size: TINY_PNG.length, folder: "/products" },
    t.ctx,
  );
  expect(upload.url).toBeTruthy();
  // In tests, store directly via the adapter instead of a presigned PUT (same result)
  await t.services.storage.adapter.put(asset.storageKey, TINY_PNG, "image/png");
  const confirmed = await assetConfirmUpload.run({ id: asset.id }, t.ctx);
  return confirmed.id;
}

describe("asset upload (T4.1)", () => {
  it("extracts size and dimensions on request→store→confirm", async () => {
    const id = await uploadAsset();
    const detail = await assetGet.run({ id }, t.ctx);
    expect(detail.status).toBe("ready");
    expect(detail.size).toBe(TINY_PNG.length);
    expect(detail.width).toBe(1);
    expect(detail.height).toBe(1);
    expect(detail.downloadUrl).toContain("/api/assets/raw/");
    expect(detail.renditions).toBeNull(); // imgproxy not configured (local)
  });

  it("rejects confirmation when the file is missing from storage", async () => {
    const { asset } = await assetRequestUpload.run(
      { filename: "ghost.png", mime: "image/png", size: 10, folder: "/" },
      t.ctx,
    );
    await expect(assetConfirmUpload.run({ id: asset.id }, t.ctx)).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it("list shows ready assets only, with folder filter and usage count", async () => {
    const list = await assetList.run({ folder: "/products" }, t.ctx);
    expect(list.items.length).toBeGreaterThanOrEqual(1);
    expect(list.items.every((a) => a.status === "ready")).toBe(true);
    expect(typeof list.items[0]!.usageCount).toBe("number");
  });

  it("usageCount in the list reflects actual usages", async () => {
    const id = await uploadAsset("counted.png");
    await entryCreate.run(
      { typeUid: "gallery", values: { title: "카운트", cover: id } },
      t.ctx,
    );
    const list = await assetList.run({ folder: "/products" }, t.ctx);
    const row = list.items.find((a) => a.id === id);
    expect(row?.usageCount).toBe(1);
  });
});

describe("usage tracking + delete protection (T4.3)", () => {
  it("media field and richtext references sync to asset_usages", async () => {
    const coverId = await uploadAsset("cover.png");
    const bodyImgId = await uploadAsset("inline.png");

    const saved = await entryCreate.run(
      {
        typeUid: "gallery",
        values: {
          title: "봄 컬렉션",
          cover: coverId,
          body: {
            type: "doc",
            content: [
              { type: "image", attrs: { assetId: bodyImgId, src: "x", alt: "" } },
            ],
          },
        },
      },
      t.ctx,
    );

    const cover = await assetGet.run({ id: coverId }, t.ctx);
    expect(cover.usages).toHaveLength(1);
    expect(cover.usages[0]).toMatchObject({ field: "cover", typeUid: "gallery" });
    expect(cover.deletable).toBe(false);

    const inline = await assetGet.run({ id: bodyImgId }, t.ctx);
    expect(inline.usages[0]!.field).toBe("body");

    // Deleting while in use → 409 (DoD)
    await expect(assetDelete.run({ id: coverId }, t.ctx)).rejects.toBeInstanceOf(
      ConflictError,
    );

    // Remove references → zero usages → deletable
    await entryUpdate.run(
      { typeUid: "gallery", id: saved.entry.id, values: { cover: null, body: null } },
      t.ctx,
    );
    const after = await assetGet.run({ id: coverId }, t.ctx);
    expect(after.deletable).toBe(true);
    const deleted = await assetDelete.run({ id: coverId }, t.ctx);
    expect(deleted.id).toBe(coverId);
  });

  it("saving a nonexistent asset as a media value returns 422", async () => {
    await expect(
      entryCreate.run(
        {
          typeUid: "gallery",
          values: { cover: "00000000-0000-4000-8000-000000000000" },
        },
        t.ctx,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("alt text (a11y, WCAG 1.1.1)", () => {
  it("starts undescribed, saves alt on the asset, and empty string marks it decorative", async () => {
    const id = await uploadAsset("alt-me.png");
    expect((await assetGet.run({ id }, t.ctx)).alt).toBeNull();

    await assetUpdate.run({ id, alt: "빨간 카메라 정면" }, t.ctx);
    expect((await assetGet.run({ id }, t.ctx)).alt).toBe("빨간 카메라 정면");

    // "" = intentionally decorative, distinct from null (not described yet)
    await assetUpdate.run({ id, alt: "" }, t.ctx);
    expect((await assetGet.run({ id }, t.ctx)).alt).toBe("");

    await assetUpdate.run({ id, alt: null }, t.ctx);
    expect((await assetGet.run({ id }, t.ctx)).alt).toBeNull();
  });

  it("delivery populate carries alt so the frontend can render it", async () => {
    const id = await uploadAsset("delivered.png");
    await assetUpdate.run({ id, alt: "제품 상세 사진" }, t.ctx);
    const [populated] = await populateValuesList(
      {
        db: t.db,
        services: t.services,
        workspace: { id: t.workspaceId, slug: t.workspaceSlug, settings: {} },
        includeDraft: true,
      },
      { displayField: "photo", fields: [{ name: "photo", type: FieldType.Media }] },
      [{ photo: id }],
    );
    expect(populated!.photo).toMatchObject({ id, alt: "제품 상세 사진", filename: "delivered.png" });
  });

  it("alt is shared by every usage — one edit covers all entries referencing the asset", async () => {
    const id = await uploadAsset("shared.png");
    await assetUpdate.run({ id, alt: "공유 설명" }, t.ctx);
    const list = await assetList.run({ folder: "/products" }, t.ctx);
    expect(list.items.find((a) => a.id === id)?.alt).toBe("공유 설명");
  });
});

describe("imgproxy signing (T4.2)", () => {
  it("generates deterministic signed URLs", () => {
    const signer = createImgproxySigner({
      baseUrl: "http://imgproxy:8080",
      keyHex: "61", // 'a'
      saltHex: "62", // 'b'
      bucket: "prina-assets",
    });
    const url = signer.renditionUrl("ws/key.png", {
      name: "thumb",
      resize: "fill",
      width: 200,
      height: 200,
    });
    expect(url).toMatch(/^http:\/\/imgproxy:8080\/[A-Za-z0-9_-]+\/rs:fill:200:200\//);
    // Same input → same signature
    expect(
      signer.renditionUrl("ws/key.png", {
        name: "thumb",
        resize: "fill",
        width: 200,
        height: 200,
      }),
    ).toBe(url);
  });

  it("joins the base and the signed path for relative and absolute bases alike", () => {
    const preset = { name: "thumb", resize: "fill", width: 200, height: 200 } as const;
    const pathOf = (baseUrl: string) =>
      createImgproxySigner({ baseUrl, keyHex: "61", saltHex: "62", bucket: "b" })
        .renditionUrl("ws/key.png", preset);
    const tail = pathOf("/img").slice("/img".length);
    expect(tail).toMatch(/^\/[A-Za-z0-9_-]+\/rs:fill:200:200\/[A-Za-z0-9_-]+$/);
    expect(pathOf("/img/")).toBe(`/img${tail}`);
    expect(pathOf("https://acme.example.com/img")).toBe(`https://acme.example.com/img${tail}`);
    expect(pathOf("https://acme.example.com/img/")).toBe(`https://acme.example.com/img${tail}`);
    expect(pathOf("http://imgproxy:8080")).toBe(`http://imgproxy:8080${tail}`);
  });
});
