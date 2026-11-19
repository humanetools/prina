/** 48-IMPL — creating workspaces: who may, what a new one starts with, and that content stays apart */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { locales, roles, userRoles, workflows, workflowTransitions, workspaces } from "../src/db/schema/index.js";
import { MAX_WORKSPACES, workspaceCreate, workspaceDelete, workspaceUpdate } from "../src/modules/workspace/commands.js";
import { assetConfirmUpload, assetRequestUpload } from "../src/modules/asset/commands.js";
import { sql } from "drizzle-orm";
import { contentTypeCreate, contentTypeList } from "../src/modules/content-type/commands.js";
import type { CommandCtx } from "../src/commands/context.js";
import { setupTestContext, type TestContext } from "./helpers.js";
import { articleDefinition } from "./fixtures.js";

let t: TestContext;
let editor: { ctx: CommandCtx; userId: string };
const created: string[] = [];

beforeAll(async () => {
  t = await setupTestContext();
  editor = await t.createUserCtx(["editor"]);
});
afterAll(async () => {
  for (const id of created) await t.db.delete(workspaces).where(eq(workspaces.id, id));
  await t.cleanup();
});

describe("workspace.create", () => {
  it("is for instance administrators only — a workspace admin role is not enough", async () => {
    await expect(workspaceCreate.run({ name: "Brand B", slug: "brand-b-denied" }, editor.ctx)).rejects.toMatchObject({ statusCode: 403 });
  });

  it("starts a workspace with its own locale, the install's workflow, the default roles and the creator as admin", async () => {
    const slug = `brand-${Date.now().toString(36)}`;
    const ws = await workspaceCreate.run({ name: "Brand B", slug, defaultLocale: { code: "en", name: "English" } }, t.ctx);
    created.push(ws.id);
    expect(ws).toMatchObject({ slug, name: "Brand B" });

    const locs = await t.db.select().from(locales).where(eq(locales.workspaceId, ws.id));
    expect(locs.map((l) => [l.code, l.isDefault])).toEqual([["en", true]]);

    const roleNames = (await t.db.select({ name: roles.name }).from(roles).where(eq(roles.workspaceId, ws.id))).map((r) => r.name).sort();
    expect(roleNames).toEqual(["admin", "developer", "editor", "publisher"]);

    // same workflow as the first workspace
    const steps = async (workspaceId: string) =>
      (await t.db.select({ f: workflowTransitions.fromState, to: workflowTransitions.toState }).from(workflowTransitions)
        .innerJoin(workflows, eq(workflows.id, workflowTransitions.workflowId))
        .where(eq(workflows.workspaceId, workspaceId))).map((r) => `${r.f}>${r.to}`).sort();
    expect(await steps(ws.id)).toEqual(await steps(t.workspaceId));

    const [admin] = await t.db.select({ id: roles.id }).from(roles).where(and(eq(roles.workspaceId, ws.id), eq(roles.name, "admin")));
    const mine = await t.db.select().from(userRoles).where(and(eq(userRoles.workspaceId, ws.id), eq(userRoles.userId, t.userId)));
    expect(mine.map((m) => m.roleId)).toEqual([admin!.id]);
  });

  it("keeps content apart: a type made in one workspace does not exist in the other", async () => {
    const ws = await workspaceCreate.run({ name: "Brand C", slug: `brand-c-${Date.now().toString(36)}` }, t.ctx);
    created.push(ws.id);
    const other: CommandCtx = { ...t.ctx, workspaceId: ws.id };
    await contentTypeCreate.run({ uid: "only_here", name: "Only here", definition: articleDefinition }, other);
    const here = (await contentTypeList.run({}, other)) as Array<{ uid: string }>;
    const there = (await contentTypeList.run({}, t.ctx)) as Array<{ uid: string }>;
    expect(here.map((c) => c.uid)).toContain("only_here");
    expect(there.map((c) => c.uid)).not.toContain("only_here");
    // without a locale given, the first workspace's default locale is used
    const locs = await t.db.select({ code: locales.code }).from(locales).where(eq(locales.workspaceId, ws.id));
    const firstDefault = await t.db.select({ code: locales.code }).from(locales).where(and(eq(locales.workspaceId, t.workspaceId), eq(locales.isDefault, true)));
    expect(locs.map((l) => l.code)).toEqual(firstDefault.map((l) => l.code));
  });

  it("refuses a taken, reserved or malformed slug, and normalises case", async () => {
    await expect(workspaceCreate.run({ name: "Dup", slug: t.workspaceSlug }, t.ctx)).rejects.toMatchObject({ statusCode: 409 });
    await expect(workspaceCreate.run({ name: "Api", slug: "api" }, t.ctx)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(workspaceCreate.run({ name: "Bad", slug: "-bad-" }, t.ctx)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(workspaceCreate.run({ name: "Space", slug: "brand d" }, t.ctx)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    const ws = await workspaceCreate.run({ name: "Upper", slug: `Brand-E-${Date.now().toString(36)}` }, t.ctx);
    created.push(ws.id);
    expect(ws.slug).toBe(ws.slug.toLowerCase());
  });
});

describe("workspace.update / workspace.delete", () => {
  it("renames (instance administrators only), never the slug", async () => {
    const ws = await workspaceCreate.run({ name: "Old name", slug: `ren-${Date.now().toString(36)}` }, t.ctx);
    created.push(ws.id);
    await expect(workspaceUpdate.run({ id: ws.id, name: "X" }, editor.ctx)).rejects.toMatchObject({ statusCode: 403 });
    const row = await workspaceUpdate.run({ id: ws.id, name: "New name" }, t.ctx);
    expect(row).toMatchObject({ name: "New name", slug: ws.slug });
  });

  it("deletes a workspace with everything in it — content, files and tables without a foreign key", async () => {
    const ws = await workspaceCreate.run({ name: "Doomed", slug: `del-${Date.now().toString(36)}` }, t.ctx);
    const ctxW: CommandCtx = { ...t.ctx, workspaceId: ws.id };
    await contentTypeCreate.run({ uid: "doomed_type", name: "Doomed", definition: articleDefinition }, ctxW);
    const body = Buffer.from("file");
    const { asset } = await assetRequestUpload.run({ filename: "a.txt", mime: "text/plain", size: body.length, folder: "/" }, ctxW);
    await t.services.storage.adapter.put(asset.storageKey, body, "text/plain");
    await assetConfirmUpload.run({ id: asset.id }, ctxW);
    // a table some edition creates without a foreign key to workspaces
    await t.db.execute(sql`CREATE TABLE IF NOT EXISTS test_loose_rows (workspace_id uuid NOT NULL, v text)`);
    await t.db.execute(sql`INSERT INTO test_loose_rows VALUES (${ws.id}, 'gone'), (${t.workspaceId}, 'kept')`);

    await expect(workspaceDelete.run({ id: ws.id, confirm: ws.slug }, editor.ctx)).rejects.toMatchObject({ statusCode: 403 });
    await expect(workspaceDelete.run({ id: ws.id, confirm: "wrong" }, t.ctx)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    const res = await workspaceDelete.run({ id: ws.id, confirm: ws.slug }, t.ctx);
    expect(res).toMatchObject({ files: 1, filesRemoved: 1 });
    expect(await t.db.select().from(workspaces).where(eq(workspaces.id, ws.id))).toHaveLength(0);
    expect(await t.db.select().from(roles).where(eq(roles.workspaceId, ws.id))).toHaveLength(0);
    expect(await t.services.storage.adapter.head(asset.storageKey)).toBeNull();
    const left = (await t.db.execute(sql`SELECT v FROM test_loose_rows ORDER BY v`)) as unknown as { rows?: Array<{ v: string }> };
    expect((left.rows ?? (left as unknown as Array<{ v: string }>)).map((r) => r.v)).toEqual(["kept"]);
    await t.db.execute(sql`DROP TABLE test_loose_rows`);
  });

  it("never deletes the primary workspace", async () => {
    const [primary] = await t.db.select().from(workspaces).where(eq(workspaces.slug, "default"));
    if (primary) {
      await expect(workspaceDelete.run({ id: primary.id, confirm: "default" }, t.ctx)).rejects.toThrow(/primary workspace/);
    } else {
      // test databases name their workspace at random; the rule is checked by slug
      const ws = await workspaceCreate.run({ name: "Primary", slug: "default" }, t.ctx);
      created.push(ws.id);
      await expect(workspaceDelete.run({ id: ws.id, confirm: "default" }, t.ctx)).rejects.toThrow(/primary workspace/);
    }
  });
});

describe("workspace limit", () => {
  it(`stops at ${MAX_WORKSPACES} workspaces per install`, async () => {
    const existing = (await t.db.select({ id: workspaces.id }).from(workspaces)).length;
    const stamp = Date.now().toString(36);
    const made: string[] = [];
    for (let i = existing; i < MAX_WORKSPACES; i++) {
      made.push((await workspaceCreate.run({ name: `Fill ${i}`, slug: `fill-${stamp}-${i}` }, t.ctx)).id);
    }
    await expect(workspaceCreate.run({ name: "One too many", slug: `over-${stamp}` }, t.ctx)).rejects.toMatchObject({ statusCode: 409 });
    for (const id of made) await t.db.delete(workspaces).where(eq(workspaces.id, id));
  }, 60_000);
});
