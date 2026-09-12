import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contentTypeCreate } from "../src/modules/content-type/commands.js";
import { entryCreate, entryDuplicate, entryUpdate } from "../src/modules/entry/commands.js";
import { localeCreate } from "../src/modules/locale/commands.js";
import { ValidationError } from "../src/lib/errors.js";
import { setupTestContext, type TestContext } from "./helpers.js";

const pageDefinition = {
  fields: [
    { name: "title", type: "text", required: true },
    { name: "slug", type: "uid", targetField: "title" },
    { name: "code", type: "text", unique: true },
  ],
  displayField: "title",
};

let t: TestContext;
beforeAll(async () => {
  t = await setupTestContext();
  await contentTypeCreate.run({ uid: "page", name: "페이지", definition: pageDefinition }, t.ctx);
});
afterAll(async () => t.cleanup());

describe("unique enforcement + uid derivation", () => {
  it("unique text field returns 422 when the value collides with another document", async () => {
    await entryCreate.run({ typeUid: "page", values: { title: "A", code: "SKU-1" } }, t.ctx);
    await expect(
      entryCreate.run({ typeUid: "page", values: { title: "B", code: "SKU-1" } }, t.ctx),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("updating oneself is not a unique violation", async () => {
    const saved = await entryCreate.run(
      { typeUid: "page", values: { title: "C", code: "SKU-2" } },
      t.ctx,
    );
    const updated = await entryUpdate.run(
      { typeUid: "page", id: saved.entry.id, values: { title: "C2" } },
      t.ctx,
    );
    expect(updated.entry.values.code).toBe("SKU-2");
  });

  it("other-locale entries of the same document are excluded from the unique check", async () => {
    await localeCreate.run({ code: "en", name: "English" }, t.ctx);
    const ko = await entryCreate.run(
      { typeUid: "page", values: { title: "다국어", code: "SKU-I18N" } },
      t.ctx,
    );
    const en = await entryCreate.run(
      {
        typeUid: "page",
        locale: "en",
        documentId: ko.entry.documentId,
        values: { title: "Multilingual", code: "SKU-I18N" },
      },
      t.ctx,
    );
    expect(en.entry.documentId).toBe(ko.entry.documentId);
  });

  it("uid left empty derives from targetField, with a -2 suffix on collision", async () => {
    const first = await entryCreate.run(
      { typeUid: "page", values: { title: "Hello World" } },
      t.ctx,
    );
    expect(first.entry.values.slug).toBe("hello-world");

    const second = await entryCreate.run(
      { typeUid: "page", values: { title: "Hello, WORLD!" } },
      t.ctx,
    );
    expect(second.entry.values.slug).toBe("hello-world-2");
  });

  it("a manually entered uid is stored as-is, 422 on duplicate", async () => {
    const saved = await entryCreate.run(
      { typeUid: "page", values: { title: "Manual", slug: "my-page" } },
      t.ctx,
    );
    expect(saved.entry.values.slug).toBe("my-page");
    await expect(
      entryCreate.run({ typeUid: "page", values: { title: "Dup", slug: "my-page" } }, t.ctx),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("uid format violations (uppercase, spaces) fail schema validation with 422", async () => {
    await expect(
      entryCreate.run({ typeUid: "page", values: { title: "Bad", slug: "Not Valid" } }, t.ctx),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  // Korean used to slugify to nothing and fall back to an 8-char id, which made every URL on a
  // Korean site meaningless. Non-Latin scripts are kept as themselves now (2026-08-24).
  it("a Korean title keeps its script in the slug", async () => {
    const saved = await entryCreate.run(
      { typeUid: "page", values: { title: "한글만 있는 제목" } },
      t.ctx,
    );
    expect(saved.entry.values.slug).toBe("한글만-있는-제목");
  });

  it("Latin text still folds to ASCII, and a source with no letters still falls back to the id", async () => {
    const folded = await entryCreate.run(
      { typeUid: "page", values: { title: "Café Münster" } },
      t.ctx,
    );
    expect(folded.entry.values.slug).toBe("cafe-munster");

    const punctuation = await entryCreate.run(
      { typeUid: "page", values: { title: "!!! ???" } },
      t.ctx,
    );
    expect(punctuation.entry.values.slug).toBe(punctuation.entry.id.slice(0, 8));
  });

  it("exclusive relation (oneToOne) returns 422 when the target is already linked to another document", async () => {
    await contentTypeCreate.run(
      {
        uid: "tag",
        name: "태그",
        definition: { fields: [{ name: "name", type: "text", required: true }] },
      },
      t.ctx,
    );
    await contentTypeCreate.run(
      {
        uid: "post",
        name: "포스트",
        definition: {
          fields: [
            { name: "title", type: "text", required: true },
            { name: "mainTag", type: "relation", target: "tag", relationKind: "oneToOne" },
            { name: "tags", type: "relation", target: "tag", relationKind: "manyToMany" },
          ],
        },
      },
      t.ctx,
    );
    const tag = await entryCreate.run({ typeUid: "tag", values: { name: "featured" } }, t.ctx);
    const post1 = await entryCreate.run(
      { typeUid: "post", values: { title: "P1", mainTag: tag.entry.id } },
      t.ctx,
    );
    // another document linking the same target via the exclusive field → rejected
    await expect(
      entryCreate.run({ typeUid: "post", values: { title: "P2", mainTag: tag.entry.id } }, t.ctx),
    ).rejects.toBeInstanceOf(ValidationError);
    // shared relation (manyToMany) is allowed
    await entryCreate.run(
      { typeUid: "post", values: { title: "P3", tags: [tag.entry.id] } },
      t.ctx,
    );
    // re-saving oneself is not a violation
    const updated = await entryUpdate.run(
      { typeUid: "post", id: post1.entry.id, values: { title: "P1v2" } },
      t.ctx,
    );
    expect(updated.entry.values.mainTag).toBe(tag.entry.id);
  });

  it("entry pointing at itself via a relation returns 422", async () => {
    await contentTypeCreate.run(
      {
        uid: "node",
        name: "노드",
        definition: {
          fields: [
            { name: "title", type: "text", required: true },
            { name: "linked", type: "relation", target: "node", relationKind: "manyToMany" },
          ],
        },
      },
      t.ctx,
    );
    const a = await entryCreate.run({ typeUid: "node", values: { title: "A" } }, t.ctx);
    const b = await entryCreate.run({ typeUid: "node", values: { title: "B" } }, t.ctx);
    // referencing another entry is fine
    await entryUpdate.run(
      { typeUid: "node", id: a.entry.id, values: { linked: [b.entry.id] } },
      t.ctx,
    );
    // self-reference is rejected
    await expect(
      entryUpdate.run(
        { typeUid: "node", id: a.entry.id, values: { linked: [b.entry.id, a.entry.id] } },
        t.ctx,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("entry duplication — copies values, re-derives uid, clears unique values", async () => {
    const src = await entryCreate.run(
      { typeUid: "page", values: { title: "Duplicate Me", code: "SKU-DUP" } },
      t.ctx,
    );
    expect(src.entry.values.slug).toBe("duplicate-me");

    const copy = await entryDuplicate.run({ typeUid: "page", id: src.entry.id }, t.ctx);
    expect(copy.entry.id).not.toBe(src.entry.id);
    expect(copy.entry.documentId).not.toBe(src.entry.documentId);
    expect(copy.entry.status).toBe("draft");
    expect(copy.entry.values.title).toBe("Duplicate Me");     // regular value copied
    expect(copy.entry.values.slug).toBe("duplicate-me-2");    // uid re-derived + suffix
    expect(copy.entry.values.code).toBeUndefined();           // unique value cleared
  });

  it("type definition is rejected when uid targetField points at a missing field", async () => {
    await expect(
      contentTypeCreate.run(
        {
          uid: "badpage",
          name: "Bad",
          definition: {
            fields: [{ name: "slug", type: "uid", targetField: "nope" }],
          },
        },
        t.ctx,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
