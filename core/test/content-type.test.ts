import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  contentTypeCreate,
  contentTypeGet,
  contentTypeUpdate,
} from "../src/modules/content-type/commands.js";
import { ValidationError, ConflictError } from "../src/lib/errors.js";
import { setupTestContext, type TestContext } from "./helpers.js";
import { articleDefinition } from "./fixtures.js";

let t: TestContext;
beforeAll(async () => {
  t = await setupTestContext();
});
afterAll(async () => t.cleanup());

describe("content_type commands (T1.1~T1.3)", () => {
  it("creates a type and stores its definition normalized", async () => {
    const created = await contentTypeCreate.run(
      { uid: "article", name: "아티클", definition: articleDefinition },
      t.ctx,
    );
    expect(created.uid).toBe("article");
    expect(created.version).toBe(1);
    expect(created.definition.fields).toHaveLength(3);
  });

  it("duplicate uid returns 409", async () => {
    await expect(
      contentTypeCreate.run(
        { uid: "article", name: "중복", definition: articleDefinition },
        t.ctx,
      ),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("unknown field type returns 422", async () => {
    await expect(
      contentTypeCreate.run(
        {
          uid: "bad1",
          name: "잘못",
          definition: { fields: [{ name: "x", type: "hologram" }] },
        },
        t.ctx,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("duplicate field name returns 422", async () => {
    await expect(
      contentTypeCreate.run(
        {
          uid: "bad2",
          name: "잘못",
          definition: {
            fields: [
              { name: "title", type: "text" },
              { name: "title", type: "number" },
            ],
          },
        },
        t.ctx,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("two variant_axis fields return 422 (§2.8)", async () => {
    await expect(
      contentTypeCreate.run(
        {
          uid: "bad3",
          name: "잘못",
          definition: {
            fields: [
              { name: "a", type: "variant_axis", axes: [{ name: "x", options: ["1"] }] },
              { name: "b", type: "variant_axis", axes: [{ name: "y", options: ["2"] }] },
            ],
          },
        },
        t.ctx,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("version increments on definition change (schema cache invalidation key)", async () => {
    const updated = await contentTypeUpdate.run(
      {
        uid: "article",
        definition: {
          ...articleDefinition,
          fields: [...articleDefinition.fields, { name: "tags", type: "json" }],
        },
      },
      t.ctx,
    );
    expect(updated.version).toBe(2);
    const fetched = await contentTypeGet.run({ uid: "article" }, t.ctx);
    expect(fetched.definition.fields.map((f) => f.name)).toContain("tags");
  });
});
