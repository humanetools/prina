/** Taxonomy hierarchy, attach, attribute sets (T2.5, §2.8) */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contentTypeCreate } from "../src/modules/content-type/commands.js";
import { componentCreate } from "../src/modules/content-type/component-commands.js";
import { entryCreate, entryGet } from "../src/modules/entry/commands.js";
import { entrySetTaxonomies } from "../src/modules/entry/document-commands.js";
import {
  taxonomyCreate,
  taxonomyNodeCreate,
  taxonomyNodeDelete,
  taxonomyNodeMove,
  taxonomyNodeUpdate,
  taxonomyTree,
} from "../src/modules/taxonomy/commands.js";
import { ValidationError } from "../src/lib/errors.js";
import { setupTestContext, type TestContext } from "./helpers.js";
import { articleDefinition } from "./fixtures.js";

let t: TestContext;
let rootId: string;
let cameraId: string;
let lensId: string;
let entryId: string;

beforeAll(async () => {
  t = await setupTestContext();
  await contentTypeCreate.run(
    { uid: "article", name: "아티클", definition: articleDefinition },
    t.ctx,
  );
  await componentCreate.run(
    {
      uid: "camera-specs",
      name: "카메라 속성",
      definition: {
        fields: [
          { name: "resolution", type: "text" },
          { name: "sensor", type: "enum", options: ["CMOS", "CCD"] },
        ],
      },
    },
    t.ctx,
  );
  const saved = await entryCreate.run(
    { typeUid: "article", values: { title: "분류 대상" } },
    t.ctx,
  );
  entryId = saved.entry.id;
});
afterAll(async () => t.cleanup());

describe("Taxonomy (T2.5)", () => {
  it("hierarchy creation — ltree path follows the parent", async () => {
    await taxonomyCreate.run({ uid: "catalog", name: "카탈로그" }, t.ctx);
    const root = await taxonomyNodeCreate.run(
      { taxonomyUid: "catalog", parentId: null, name: "전자", slug: "electronics" },
      t.ctx,
    );
    rootId = root.id;
    const camera = await taxonomyNodeCreate.run(
      {
        taxonomyUid: "catalog",
        parentId: rootId,
        name: "카메라",
        slug: "camera",
        attributeComponentUid: "camera-specs",
      },
      t.ctx,
    );
    cameraId = camera.id;
    const lens = await taxonomyNodeCreate.run(
      { taxonomyUid: "catalog", parentId: camera.id, name: "렌즈", slug: "lens" },
      t.ctx,
    );
    lensId = lens.id;
    expect(camera.path).toBe("electronics.camera");
    expect(lens.path).toBe("electronics.camera.lens");
  });

  it("multi-taxonomy attach + attribute set value validation and storage", async () => {
    // invalid attribute value (enum violation) → 422
    await expect(
      entrySetTaxonomies.run(
        {
          typeUid: "article",
          id: entryId,
          attachments: [
            { nodeId: cameraId, attributeValues: { sensor: "PLASMA" } },
          ],
        },
        t.ctx,
      ),
    ).rejects.toBeInstanceOf(ValidationError);

    // sending values to a node without an attribute set → 422
    await expect(
      entrySetTaxonomies.run(
        {
          typeUid: "article",
          id: entryId,
          attachments: [{ nodeId: rootId, attributeValues: { any: 1 } }],
        },
        t.ctx,
      ),
    ).rejects.toBeInstanceOf(ValidationError);

    // happy path: multi-attach to 2 nodes
    const result = await entrySetTaxonomies.run(
      {
        typeUid: "article",
        id: entryId,
        attachments: [
          {
            nodeId: cameraId,
            attributeValues: { resolution: "20MP", sensor: "CMOS" },
          },
          { nodeId: rootId },
        ],
      },
      t.ctx,
    );
    expect(result.attached).toBe(2);

    const detail = await entryGet.run({ typeUid: "article", id: entryId }, t.ctx);
    expect(detail.taxonomies).toHaveLength(2);
    const cameraAttach = detail.taxonomies.find((x) => x.nodeId === cameraId)!;
    expect(cameraAttach.taxonomy).toBe("catalog"); // taxonomy uid — forms the `<uid>:<path>` filter spec
    expect(cameraAttach.attributeComponentUid).toBe("camera-specs");
    expect(cameraAttach.attributeValues).toEqual({ resolution: "20MP", sensor: "CMOS" });
  });

  it("subtree move — descendant paths are updated in bulk", async () => {
    const industry = await taxonomyNodeCreate.run(
      { taxonomyUid: "catalog", parentId: null, name: "산업", slug: "industrial" },
      t.ctx,
    );
    const moved = await taxonomyNodeMove.run(
      { nodeId: cameraId, newParentId: industry.id },
      t.ctx,
    );
    expect(moved.path).toBe("industrial.camera");

    const tree = await taxonomyTree.run({ taxonomyUid: "catalog" }, t.ctx);
    const lens = tree.find((n) => n.id === lensId)!;
    expect(lens.path).toBe("industrial.camera.lens");

    // moving under one's own descendant is rejected
    await expect(
      taxonomyNodeMove.run({ nodeId: cameraId, newParentId: lensId }, t.ctx),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("node update — a new slug rewrites the subtree's paths; a sibling's path is a conflict", async () => {
    const tree = await taxonomyTree.run({ taxonomyUid: "catalog" }, t.ctx);
    const camera = tree.find((n) => n.id === cameraId)!;
    const lensBefore = tree.find((n) => n.id === lensId)!;
    const parentPath = camera.path.slice(0, camera.path.lastIndexOf("."));
    const updated = await taxonomyNodeUpdate.run({ nodeId: cameraId, slug: "cameras-dslr" }, t.ctx);
    expect(updated.slug).toBe("cameras-dslr");
    expect(updated.path).toBe(`${parentPath}.cameras_dslr`);
    const after = await taxonomyTree.run({ taxonomyUid: "catalog" }, t.ctx);
    expect(after.find((n) => n.id === lensId)!.path).toBe(lensBefore.path.replace(camera.path, updated.path));

    const sibling = await taxonomyNodeCreate.run({ taxonomyUid: "catalog", parentId: camera.parentId, name: "Audio", slug: "audio" }, t.ctx);
    await expect(taxonomyNodeUpdate.run({ nodeId: sibling.id, slug: "cameras-dslr" }, t.ctx)).rejects.toThrow(/already exists/);
    // back to the original so later tests see the same tree
    await taxonomyNodeUpdate.run({ nodeId: cameraId, slug: camera.slug }, t.ctx);
    await taxonomyNodeDelete.run({ nodeId: sibling.id }, t.ctx);
  });

  it("node update — renames in place and swaps the attribute set; slug and path stay", async () => {
    const before = (await taxonomyTree.run({ taxonomyUid: "catalog" }, t.ctx)).find((n) => n.id === lensId)!;
    const renamed = await taxonomyNodeUpdate.run({ nodeId: lensId, name: "Lenses & optics" }, t.ctx);
    expect(renamed.name).toBe("Lenses & optics");
    expect(renamed.path).toBe(before.path);
    expect(renamed.slug).toBe(before.slug);
    expect(renamed.attributeComponentUid).toBe(before.attributeComponentUid); // untouched when not sent

    const detached = await taxonomyNodeUpdate.run({ nodeId: lensId, attributeComponentUid: null }, t.ctx);
    expect(detached.attributeComponentUid).toBeNull();
    expect(detached.name).toBe("Lenses & optics");
    await expect(
      taxonomyNodeUpdate.run({ nodeId: lensId, attributeComponentUid: "no_such_component" }, t.ctx),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("node deletion — removes the subtree + cleans up attaches", async () => {
    await taxonomyNodeDelete.run({ nodeId: cameraId }, t.ctx);
    const tree = await taxonomyTree.run({ taxonomyUid: "catalog" }, t.ctx);
    expect(tree.find((n) => n.id === cameraId)).toBeUndefined();
    expect(tree.find((n) => n.id === lensId)).toBeUndefined();

    const detail = await entryGet.run({ typeUid: "article", id: entryId }, t.ctx);
    expect(detail.taxonomies).toHaveLength(1); // only the rootId attach remains
  });
});
