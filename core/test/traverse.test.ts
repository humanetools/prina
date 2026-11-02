/** T9.2 multi-hop graph traversal — path chains, depth expansion, published filter, cycle termination */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contentTypeCreate } from "../src/modules/content-type/commands.js";
import { entryCreate } from "../src/modules/entry/commands.js";
import { graphTraverse } from "../src/modules/entry/graph-commands.js";
import { traverseGraph } from "../src/modules/delivery/traverse.js";
import { NotFoundError } from "../src/lib/errors.js";
import { publishEntry,
  setupTestContext, type TestContext } from "./helpers.js";

let t: TestContext;
let productId: string;
let seriesId: string;
let brandId: string;
let draftSeriesId: string;

async function publish(typeUid: string, id: string) {
  await publishEntry(t.ctx, typeUid, id);
}

beforeAll(async () => {
  t = await setupTestContext();
  // Create a cycle via brand → (flagship) product: product → series → brand → product
  await contentTypeCreate.run(
    {
      uid: "kg-brand",
      name: "KG Brand",
      definition: {
        fields: [
          { name: "name", type: "text", required: true },
          { name: "flagship", type: "relation", target: "kg-product", relationKind: "oneToOne" },
        ],
        displayField: "name",
      },
    },
    t.ctx,
  );
  await contentTypeCreate.run(
    {
      uid: "kg-series",
      name: "KG Series",
      definition: {
        fields: [
          { name: "name", type: "text", required: true },
          { name: "brand", type: "relation", target: "kg-brand", relationKind: "manyToOne" },
        ],
        displayField: "name",
      },
    },
    t.ctx,
  );
  await contentTypeCreate.run(
    {
      uid: "kg-product",
      name: "KG Product",
      definition: {
        fields: [
          { name: "title", type: "text", required: true },
          { name: "series", type: "relation", target: "kg-series", relationKind: "manyToOne" },
        ],
        displayField: "title",
      },
    },
    t.ctx,
  );

  const brand = await entryCreate.run(
    { typeUid: "kg-brand", values: { name: "Hikro" } },
    t.ctx,
  );
  brandId = brand.entry.id;
  const series = await entryCreate.run(
    { typeUid: "kg-series", values: { name: "S-Line", brand: brandId } },
    t.ctx,
  );
  seriesId = series.entry.id;
  const product = await entryCreate.run(
    { typeUid: "kg-product", values: { title: "S-1000", series: seriesId } },
    t.ctx,
  );
  productId = product.entry.id;
  // cycle: brand.flagship → product
  const { entryUpdate } = await import("../src/modules/entry/commands.js");
  await entryUpdate.run(
    { typeUid: "kg-brand", id: brandId, values: { name: "Hikro", flagship: productId } },
    t.ctx,
  );
  // published product pointing at a draft series (for the published-filter check)
  const draftSeries = await entryCreate.run(
    { typeUid: "kg-series", values: { name: "Draft-Line" } },
    t.ctx,
  );
  draftSeriesId = draftSeries.entry.id;

  await publish("kg-brand", brandId);
  await publish("kg-series", seriesId);
  await publish("kg-product", productId);
});
afterAll(async () => {
  await t.cleanup();
});

describe("graph.traverse (T9.2)", () => {
  it("path mode: reaches the brand via the 2-hop series.brand chain", async () => {
    const r = await graphTraverse.run(
      { typeUid: "kg-product", id: productId, path: ["series", "brand"] },
      t.ctx,
    );
    expect(r.mode).toBe("path");
    expect(r.targets).toEqual([brandId]);
    expect(r.edges).toHaveLength(2);
    expect(r.edges[0]).toMatchObject({ from: productId, to: seriesId, field: "series", depth: 1 });
    expect(r.edges[1]).toMatchObject({ from: seriesId, to: brandId, field: "brand", depth: 2 });
    const brandNode = r.nodes.find((n) => n.id === brandId);
    expect(brandNode).toMatchObject({ typeUid: "kg-brand", display: "Hikro" });
  });

  it("path mode: empty result when an intermediate hop field differs", async () => {
    const r = await graphTraverse.run(
      { typeUid: "kg-product", id: productId, path: ["series", "nope"] },
      t.ctx,
    );
    expect(r.targets).toEqual([]);
    expect(r.edges).toHaveLength(1); // walks only hop 1 (series) and stops
  });

  it("depth mode: terminates without infinite expansion in the cycle (product→series→brand→product)", async () => {
    const r = await graphTraverse.run(
      { typeUid: "kg-product", id: productId, depth: 5 },
      t.ctx,
    );
    // product→series, series→brand, brand→product (cycle — blocked via visited)
    expect(r.edges).toHaveLength(2);
    expect(r.truncated).toBe(false);
    expect(new Set(r.nodes.map((n) => n.id))).toEqual(new Set([productId, seriesId, brandId]));
  });

  it("publishedOnly: does not walk draft targets", async () => {
    // add productId → draftSeriesId relation (draft series)
    const { entryUpdate } = await import("../src/modules/entry/commands.js");
    await entryUpdate.run(
      { typeUid: "kg-product", id: productId, values: { title: "S-1000", series: draftSeriesId } },
      t.ctx,
    );
    const all = await traverseGraph(t.ctx.db, t.ctx.workspaceId, {
      startId: productId,
      depth: 1,
      publishedOnly: false,
    });
    expect(all.targets).toContain(draftSeriesId);
    const pub = await traverseGraph(t.ctx.db, t.ctx.workspaceId, {
      startId: productId,
      depth: 1,
      publishedOnly: true,
    });
    expect(pub.targets).not.toContain(draftSeriesId);
    // restore original state
    await entryUpdate.run(
      { typeUid: "kg-product", id: productId, values: { title: "S-1000", series: seriesId } },
      t.ctx,
    );
  });

  it("type mismatch or missing entry is NotFound", async () => {
    await expect(
      graphTraverse.run({ typeUid: "kg-brand", id: productId, depth: 1 }, t.ctx),
    ).rejects.toThrow(NotFoundError);
  });
});
