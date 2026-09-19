import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contentTypeCreate } from "../src/modules/content-type/commands.js";
import { entryCreate, entryGet, entryUpdate } from "../src/modules/entry/commands.js";
import { setupTestContext, type TestContext } from "./helpers.js";
import { productDefinition } from "./fixtures.js";

let t: TestContext;
let parentId: string;

beforeAll(async () => {
  t = await setupTestContext();
  await contentTypeCreate.run(
    { uid: "product", name: "상품", definition: productDefinition },
    t.ctx,
  );
});
afterAll(async () => t.cleanup());

describe("Variants derivation and inheritance (T1.6 DoD, §2.8)", () => {
  it("creating a product with a 2-option color axis → auto-derives 2 child SKUs", async () => {
    const saved = await entryCreate.run(
      {
        typeUid: "product",
        values: {
          title: "티셔츠",
          price: 10000,
          variants: { 색상: ["Red", "Blue"] },
        },
      },
      t.ctx,
    );
    parentId = saved.entry.id;
    expect(saved.variants.created).toBe(2);

    const detail = await entryGet.run({ typeUid: "product", id: parentId }, t.ctx);
    expect(detail.variants).toHaveLength(2);
    const combos = detail.variants.map((v) => v.variantValues?.색상).sort();
    expect(combos).toEqual(["Blue", "Red"]);
  });

  it("child effective values are inherited from the parent", async () => {
    const detail = await entryGet.run({ typeUid: "product", id: parentId }, t.ctx);
    const child = detail.variants[0]!;
    const childDetail = await entryGet.run({ typeUid: "product", id: child.id }, t.ctx);
    expect(childDetail.effectiveValues.price).toBe(10000);
    expect(childDetail.effectiveValues.title).toBe("티셔츠");
    // the variant_axis field itself is not inherited by children
    expect(childDetail.effectiveValues.variants).toBeUndefined();
  });

  it("child field override + parent update only propagates to non-overridden children (DoD)", async () => {
    const detail = await entryGet.run({ typeUid: "product", id: parentId }, t.ctx);
    const [childA, childB] = detail.variants;

    // override childA's price
    await entryUpdate.run(
      { typeUid: "product", id: childA!.id, values: { price: 12000 } },
      t.ctx,
    );

    // update the parent price
    await entryUpdate.run(
      { typeUid: "product", id: parentId, values: { price: 11000 } },
      t.ctx,
    );

    const a = await entryGet.run({ typeUid: "product", id: childA!.id }, t.ctx);
    const b = await entryGet.run({ typeUid: "product", id: childB!.id }, t.ctx);
    expect(a.effectiveValues.price).toBe(12000); // override kept
    expect(a.overriddenFields).toContain("price");
    expect(b.effectiveValues.price).toBe(11000); // parent value propagated
  });

  it("children sync when the axis option combination changes (remove/add)", async () => {
    const updated = await entryUpdate.run(
      {
        typeUid: "product",
        id: parentId,
        values: { variants: { 색상: ["Red", "Green"] } },
      },
      t.ctx,
    );
    expect(updated.variants.removed).toBe(1); // Blue removed
    expect(updated.variants.created).toBe(1); // Green added
    expect(updated.variants.kept).toBe(1); // Red kept

    const detail = await entryGet.run({ typeUid: "product", id: parentId }, t.ctx);
    const combos = detail.variants.map((v) => v.variantValues?.색상).sort();
    expect(combos).toEqual(["Green", "Red"]);
  });
});
