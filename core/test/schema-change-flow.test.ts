/**
 * 56-IMPL — a schema change never rewrites entries: it asks first, takes the published entries it breaks
 * back to draft, and from then on the entry says what to fix, saves while it is being fixed, and publishes
 * only once it fits again.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { auditLog, entries } from "../src/db/schema/index.js";
import { contentTypeCreate, contentTypeUpdate } from "../src/modules/content-type/commands.js";
import { componentCreate, componentUpdate } from "../src/modules/content-type/component-commands.js";
import { entryCreate, entryGet, entryList, entryUpdate } from "../src/modules/entry/commands.js";
import { stripStaleKeys } from "../src/modules/entry/schema-issues.js";
import { buildApp } from "../src/app.js";
import { createDb } from "../src/db/client.js";
import { publishEntry, setupTestContext, type TestContext } from "./helpers.js";

let t: TestContext;
const ids: Record<string, string> = {};
let seq = 0;

type Def = Record<string, unknown>;
const KEEP = { name: "keep", type: "text" };
const fieldsOf = (f: Def) => ({ fields: [KEEP, { name: "f", ...f }] });

/** A type with one field under test and entries holding `values` of it; the first `published` are published */
async function seed(before: Def, values: unknown[], published = 0): Promise<{ uid: string; entryIds: string[] }> {
  const uid = `s${++seq}`;
  await contentTypeCreate.run({ uid, name: uid, definition: fieldsOf(before) }, t.ctx);
  const entryIds: string[] = [];
  for (const [i, f] of values.entries()) {
    const { entry } = await entryCreate.run({ typeUid: uid, values: { keep: `e${i}`, f } }, t.ctx);
    if (i < published) await publishEntry(t.ctx, uid, entry.id);
    entryIds.push(entry.id);
  }
  return { uid, entryIds };
}
const change = (uid: string, after: Def, confirm?: boolean) =>
  contentTypeUpdate.run({ uid, definition: fieldsOf(after), ...(confirm ? { confirm } : {}) }, t.ctx);
const statusOf = async (id: string) => (await t.db.select({ s: entries.status }).from(entries).where(eq(entries.id, id)))[0]!.s;
const detail = (uid: string, id: string) => entryGet.run({ typeUid: uid, id }, t.ctx);
const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as { code: string; statusCode: number; message: string; details: Record<string, unknown> };
  }
  throw new Error("expected a refusal");
};

const TO_ONE = { type: "relation", target: "tgt", relationKind: "manyToOne" };
const TO_MANY = { type: "relation", target: "tgt", relationKind: "manyToMany" };

beforeAll(async () => {
  t = await setupTestContext();
  await contentTypeCreate.run({ uid: "tgt", name: "tgt", definition: { fields: [{ name: "title", type: "text" }] } }, t.ctx);
  await contentTypeCreate.run({ uid: "tgt2", name: "tgt2", definition: { fields: [{ name: "title", type: "text" }] } }, t.ctx);
  for (const k of ["t1", "t2"]) ids[k] = (await entryCreate.run({ typeUid: "tgt", values: { title: k } }, t.ctx)).entry.id;
});
afterAll(async () => t.cleanup());

describe("saving a schema change", () => {
  it("goes through without asking when no entry stops fitting", async () => {
    const { uid } = await seed({ type: "text" }, ["a", "b"], 1);
    const res = await change(uid, { type: "text", label: "Renamed label", maxLength: 50 });
    expect(res.version).toBe(2);
    expect("schemaChange" in res).toBe(false);
  });

  it("is refused until confirmed when entries stop fitting — and says how many, which fields, how many are live", async () => {
    const { uid, entryIds } = await seed(TO_ONE, [ids.t1, ids.t2, null], 1);
    const err = await refusal(change(uid, TO_MANY));
    expect(err).toMatchObject({ code: "SCHEMA_CHANGE_NEEDS_CONFIRMATION", statusCode: 409 });
    expect(err.message).toMatch(/2 entries needing a fix.*1 published entry will be taken back to draft/);
    expect(err.details).toMatchObject({ affected: 2, published: 1, byField: { f: 2 }, types: [{ uid, affected: 2, published: 1 }] });
    expect(JSON.stringify(err.details)).not.toContain("publishedIds");
    // nothing changed
    expect((await detail(uid, entryIds[0]!)).schemaIssues).toEqual([]);
    expect(await statusOf(entryIds[0]!)).toBe("published");
  });

  it("when confirmed: the definition changes, broken published entries go back to draft, the rest stay as they were", async () => {
    const { uid, entryIds } = await seed(TO_ONE, [ids.t1, null, ids.t2], 2);
    // entry 0: published + broken · entry 1: published + still fits (empty) · entry 2: draft + broken
    const res = await change(uid, TO_MANY, true);
    expect(res).toMatchObject({ version: 2, schemaChange: { affected: 2, published: 1, unpublished: 1 } });
    expect([await statusOf(entryIds[0]!), await statusOf(entryIds[1]!), await statusOf(entryIds[2]!)]).toEqual(["draft", "published", "draft"]);
    // the values themselves were not touched
    const [row] = await t.db.select({ values: entries.values }).from(entries).where(eq(entries.id, entryIds[0]!));
    expect((row!.values as { f: unknown }).f).toBe(ids.t1);
    const logged = await t.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "entry.unpublished_by_schema_change"), eq(auditLog.resourceId, entryIds[0]!)));
    expect(logged[0]!.payload).toMatchObject({ typeUid: uid, cause: { kind: "content_type", uid } });
  });

  it("does not count again what an earlier change already broke", async () => {
    const { uid } = await seed(TO_ONE, [ids.t1]);
    await change(uid, TO_MANY, true);
    // a later, harmless change must not be held up by the entry that is still waiting to be fixed
    const res = await change(uid, { ...TO_MANY, label: "Links" });
    expect("schemaChange" in res).toBe(false);
  });

  it("counts references that point at the wrong type after the target changes", async () => {
    const { uid } = await seed(TO_ONE, [ids.t1, null]);
    const err = await refusal(change(uid, { ...TO_ONE, target: "tgt2" }));
    expect(err.details).toMatchObject({ affected: 1, byField: { f: 1 } });
  });

  it("a removed field needs no fix and unpublishes nothing", async () => {
    const { uid, entryIds } = await seed({ type: "text" }, ["hello"], 1);
    const res = await contentTypeUpdate.run({ uid, definition: { fields: [KEEP] } }, t.ctx);
    expect("schemaChange" in res).toBe(false);
    expect(await statusOf(entryIds[0]!)).toBe("published");
    expect((await detail(uid, entryIds[0]!)).schemaIssues).toEqual([]);
  });
});

describe("an entry that needs fixing", () => {
  it("lists what to fix, shows in the list, saves other fields, refuses a wrong value in the field it touches", async () => {
    const { uid, entryIds } = await seed(TO_ONE, [ids.t1, null]);
    await change(uid, TO_MANY, true);
    const id = entryIds[0]!;

    expect((await detail(uid, id)).schemaIssues).toEqual([{ field: "f", path: "f", message: "must be array" }]);
    const list = await entryList.run({ typeUid: uid }, t.ctx);
    expect(list.items.find((r) => r.id === id)).toMatchObject({ needsFix: true });
    expect("needsFix" in list.items.find((r) => r.id === entryIds[1])!).toBe(false);

    // another field: saved, the broken one stays as it was
    await entryUpdate.run({ typeUid: uid, id, values: { keep: "edited" } }, t.ctx);
    expect((await detail(uid, id)).entry.values).toMatchObject({ keep: "edited", f: ids.t1 });
    // touching the broken field with another wrong value is still a 422
    await expect(entryUpdate.run({ typeUid: uid, id, values: { f: "not-a-list" } }, t.ctx)).rejects.toThrow(/violate the content type schema/);
    // and a caller cannot slip a wrong value into a healthy field either
    await expect(entryUpdate.run({ typeUid: uid, id, values: { keep: 5 } }, t.ctx)).rejects.toThrow(/violate the content type schema/);
  });

  it("cannot be published until it is fixed — then it can", async () => {
    const { uid, entryIds } = await seed(TO_ONE, [ids.t1], 1);
    await change(uid, TO_MANY, true);
    const id = entryIds[0]!;
    expect(await statusOf(id)).toBe("draft");
    const err = await refusal(publishEntry(t.ctx, uid, id));
    // (the helper walks the workflow; whichever step publishes is the one that is refused)
    expect(err.message).toMatch(/need fixing after a schema change|Transition not allowed/);
    expect(await statusOf(id)).not.toBe("published");

    await entryUpdate.run({ typeUid: uid, id, values: { f: [ids.t1] } }, t.ctx);
    expect((await detail(uid, id)).schemaIssues).toEqual([]);
    await publishEntry(t.ctx, uid, id);
    expect(await statusOf(id)).toBe("published");
  });

  it("clearing the field is a fix too", async () => {
    const { uid, entryIds } = await seed({ type: "text" }, ["abc"]);
    await change(uid, { type: "number" }, true);
    const id = entryIds[0]!;
    expect((await detail(uid, id)).schemaIssues[0]).toMatchObject({ field: "f", message: "must be number" });
    await entryUpdate.run({ typeUid: uid, id, values: { f: null } }, t.ctx);
    expect((await detail(uid, id)).schemaIssues).toEqual([]);
  });

  it("stays saveable whatever the old shape — single↔many of media-like, component and zone fields", async () => {
    await componentCreate.run({ uid: "card", name: "card", definition: { fields: [{ name: "title", type: "text" }] } }, t.ctx);
    const cases: Array<[Def, unknown, Def]> = [
      [TO_MANY, [ids.t1, ids.t2], TO_ONE],
      [{ type: "component", component: "card" }, { title: "x" }, { type: "component", component: "card", repeatable: true }],
      [{ type: "component", component: "card", repeatable: true }, [{ title: "x" }, { title: "y" }], { type: "component", component: "card" }],
      [{ type: "component", component: "card" }, { title: "x" }, { type: "dynamic_zone", components: ["card"] }],
      [{ type: "enum", options: ["red", "blue"] }, "red", { type: "enum", options: ["blue"] }],
    ];
    for (const [before, value, after] of cases) {
      const { uid, entryIds } = await seed(before, [value]);
      await change(uid, after, true);
      await entryUpdate.run({ typeUid: uid, id: entryIds[0]!, values: { keep: "still saves" } }, t.ctx);
      expect((await detail(uid, entryIds[0]!)).schemaIssues.length, JSON.stringify(after)).toBeGreaterThan(0);
    }
  });
});

describe("a change to a component definition", () => {
  it("weighs every type that uses the component, also through another component and inside zones", async () => {
    await componentCreate.run({ uid: "leaf", name: "leaf", definition: { fields: [{ name: "count", type: "text" }] } }, t.ctx);
    await componentCreate.run({ uid: "wrap", name: "wrap", definition: { fields: [{ name: "inner", type: "component", component: "leaf" }] } }, t.ctx);
    await contentTypeCreate.run({ uid: "direct", name: "direct", definition: { fields: [{ name: "c", type: "component", component: "leaf" }] } }, t.ctx);
    await contentTypeCreate.run({ uid: "nested", name: "nested", definition: { fields: [{ name: "w", type: "component", component: "wrap" }] } }, t.ctx);
    await contentTypeCreate.run({ uid: "zoned", name: "zoned", definition: { fields: [{ name: "z", type: "dynamic_zone", components: ["leaf"] }] } }, t.ctx);
    await contentTypeCreate.run({ uid: "unrelated", name: "unrelated", definition: { fields: [KEEP] } }, t.ctx);
    const a = (await entryCreate.run({ typeUid: "direct", values: { c: { count: "7" } } }, t.ctx)).entry.id;
    const b = (await entryCreate.run({ typeUid: "nested", values: { w: { inner: { count: "8" } } } }, t.ctx)).entry.id;
    const c = (await entryCreate.run({ typeUid: "zoned", values: { z: [{ __component: "leaf", count: "9" }] } }, t.ctx)).entry.id;
    await entryCreate.run({ typeUid: "unrelated", values: { keep: "x" } }, t.ctx);
    await publishEntry(t.ctx, "direct", a);

    const next = { fields: [{ name: "count", type: "number" }] };
    const err = await refusal(componentUpdate.run({ uid: "leaf", definition: next }, t.ctx));
    expect(err.code).toBe("SCHEMA_CHANGE_NEEDS_CONFIRMATION");
    expect(err.details).toMatchObject({ affected: 3, published: 1 });
    expect((err.details.types as Array<{ uid: string }>).map((x) => x.uid).sort()).toEqual(["direct", "nested", "zoned"]);

    const res = await componentUpdate.run({ uid: "leaf", definition: next, confirm: true }, t.ctx);
    expect(res).toMatchObject({ schemaChange: { affected: 3, unpublished: 1 } });
    expect(await statusOf(a)).toBe("draft");
    expect((await detail("nested", b)).schemaIssues).toEqual([{ field: "w", path: "w.inner.count", message: "must be number" }]);
    expect((await detail("zoned", c)).schemaIssues[0]).toMatchObject({ field: "z", path: "z.0.count" });
  });

  it("a field removed from a component no longer locks the entries using it — its values wait for a confirmation", async () => {
    await componentCreate.run({ uid: "note", name: "note", definition: { fields: [{ name: "title", type: "text" }, { name: "extra", type: "text" }] } }, t.ctx);
    await contentTypeCreate.run({ uid: "noted", name: "noted", definition: { fields: [KEEP, { name: "n", type: "component", component: "note" }, { name: "z", type: "dynamic_zone", components: ["note"] }] } }, t.ctx);
    const id = (await entryCreate.run({ typeUid: "noted", values: { keep: "a", n: { title: "t", extra: "e" }, z: [{ __component: "note", title: "t", extra: "e" }] } }, t.ctx)).entry.id;
    const res = await componentUpdate.run({ uid: "note", definition: { fields: [{ name: "title", type: "text" }] } }, t.ctx);
    expect("schemaChange" in res).toBe(false); // nothing to fix

    // the entry says what is left over, and still saves
    const before = await detail("noted", id);
    expect(before.schemaIssues).toEqual([]);
    expect(before.removedFields).toEqual([{ path: "n.extra", value: "e" }, { path: "z.0.extra", value: "e" }]);
    await entryUpdate.run({ typeUid: "noted", id, values: { keep: "b" } }, t.ctx);
    // the admin sends the whole component value back, leftover key included — accepted, and still kept
    await entryUpdate.run({ typeUid: "noted", id, values: { n: { title: "t2", extra: "e" } } }, t.ctx);
    expect((await detail("noted", id)).removedFields).toHaveLength(2);
    // a key nobody ever stored is still refused
    await expect(entryUpdate.run({ typeUid: "noted", id, values: { n: { title: "t", invented: 1 } } }, t.ctx)).rejects.toThrow(/violate the content type schema/);

    // confirming removes them for good
    await entryUpdate.run({ typeUid: "noted", id, dropRemovedFields: true }, t.ctx);
    const after = await detail("noted", id);
    expect(after.removedFields).toEqual([]);
    const values = after.entry.values as { n: Record<string, unknown>; z: Array<Record<string, unknown>> };
    expect(values.n).toEqual({ title: "t2" });
    expect(values.z[0]).toMatchObject({ __component: "note", title: "t" });
    expect("extra" in values.z[0]!).toBe(false);
  });
});

describe("a removed field", () => {
  it("keeps its values on the entry until the removal is confirmed there", async () => {
    const { uid, entryIds } = await seed({ type: "text" }, ["hello"], 1);
    await contentTypeUpdate.run({ uid, definition: { fields: [KEEP] } }, t.ctx);
    const id = entryIds[0]!;
    expect((await detail(uid, id)).removedFields).toEqual([{ path: "f", value: "hello" }]);
    // an ordinary save does not throw the value away
    await entryUpdate.run({ typeUid: uid, id, values: { keep: "edited" } }, t.ctx);
    expect((await detail(uid, id)).removedFields).toEqual([{ path: "f", value: "hello" }]);
    // bringing the field back brings the value back
    await contentTypeUpdate.run({ uid, definition: fieldsOf({ type: "text" }) }, t.ctx);
    expect((await detail(uid, id)).entry.values).toMatchObject({ f: "hello" });
    expect((await detail(uid, id)).removedFields).toEqual([]);
    // removed again and confirmed: gone
    await contentTypeUpdate.run({ uid, definition: { fields: [KEEP] } }, t.ctx);
    await entryUpdate.run({ typeUid: uid, id, dropRemovedFields: true }, t.ctx);
    expect((await detail(uid, id)).entry.values).toEqual({ keep: "edited" });
  });
});

describe("over REST", () => {
  // the commands above are what the admin calls through these routes — a flag the route forgets to pass on
  // makes the screen's button do nothing (it did, once)
  it("the entry route passes the removal confirmation on, and the type route the rename map and the confirmation", async () => {
    const { db } = createDb(process.env.TEST_DATABASE_URL!);
    const app = buildApp({
      env: { LOG_LEVEL: "error", NODE_ENV: "test", ADMIN_DIST_PATH: undefined, S3_REGION: "us-east-1" } as Parameters<typeof buildApp>[0]["env"],
      db,
      services: t.services,
    });
    const headers = { "x-prina-workspace": t.workspaceSlug, "x-prina-actor": `human:${t.ctx.actor.id}`, "content-type": "application/json" };
    const call = (method: "PUT" | "GET", url: string, payload?: unknown) => app.inject({ method, url, headers, ...(payload ? { payload: JSON.stringify(payload) } : {}) });
    try {
      const { uid, entryIds } = await seed({ type: "text" }, ["hello"]);
      const id = entryIds[0]!;

      // rename over REST: the value follows
      const renamed = await call("PUT", `/api/content-types/${uid}`, { definition: { fields: [KEEP, { name: "g", type: "text" }] }, renames: { f: "g" } });
      expect(renamed.statusCode).toBe(200);
      expect((await call("GET", `/api/content/${uid}/${id}`)).json().entry.values).toMatchObject({ g: "hello" });

      // a breaking change: 409 with the counts, then accepted with confirm
      const refused = await call("PUT", `/api/content-types/${uid}`, { definition: { fields: [KEEP, { name: "g", type: "number" }] } });
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error).toMatchObject({ code: "SCHEMA_CHANGE_NEEDS_CONFIRMATION", details: { affected: 1 } });
      expect((await call("PUT", `/api/content-types/${uid}`, { definition: { fields: [KEEP, { name: "g", type: "number" }] }, confirm: true })).statusCode).toBe(200);

      // remove the field: the value waits, then goes when the entry route is told to drop it
      expect((await call("PUT", `/api/content-types/${uid}`, { definition: { fields: [KEEP] } })).statusCode).toBe(200);
      expect((await call("GET", `/api/content/${uid}/${id}`)).json().removedFields).toEqual([{ path: "g", value: "hello" }]);
      expect((await call("PUT", `/api/content/${uid}/${id}`, { values: {}, dropRemovedFields: true })).statusCode).toBe(200);
      const after = (await call("GET", `/api/content/${uid}/${id}`)).json();
      expect(after.removedFields).toEqual([]);
      expect(after.entry.values).toEqual({ keep: "e0" });
    } finally {
      await app.close();
    }
  });
});

describe("a renamed field", () => {
  it("keeps the values of every entry, and settings that point at the field follow", async () => {
    const uid = `r${++seq}`;
    await contentTypeCreate.run(
      { uid, name: uid, definition: { fields: [{ name: "title", type: "text" }, { name: "slug", type: "uid", targetField: "title" }, { name: "link", ...TO_ONE }], displayField: "title" } },
      t.ctx,
    );
    const a = (await entryCreate.run({ typeUid: uid, values: { title: "Spring", link: ids.t1 } }, t.ctx)).entry.id;
    const b = (await entryCreate.run({ typeUid: uid, values: { title: "Summer" } }, t.ctx)).entry.id;
    await publishEntry(t.ctx, uid, a);

    const res = await contentTypeUpdate.run(
      {
        uid,
        definition: { fields: [{ name: "headline", type: "text" }, { name: "slug", type: "uid", targetField: "title" }, { name: "page", ...TO_ONE }], displayField: "title" },
        renames: { title: "headline", link: "page" },
      },
      t.ctx,
    );
    expect("schemaChange" in res).toBe(false); // no entry needs fixing, nothing is unpublished
    expect(res.definition.displayField).toBe("headline");
    expect(res.definition.fields.find((f) => f.name === "slug")).toMatchObject({ targetField: "headline" });

    const da = await detail(uid, a);
    expect(da.entry.values).toMatchObject({ headline: "Spring", page: ids.t1 });
    expect("title" in da.entry.values || "link" in da.entry.values).toBe(false);
    expect(da.removedFields).toEqual([]);
    expect(da.entry.status).toBe("published");
    expect((await detail(uid, b)).entry.values).toMatchObject({ headline: "Summer" });
    // the relation table now knows the link under its new name
    const rels = await t.db.execute(sql`SELECT field FROM entry_relations WHERE from_entry_id = ${a}`);
    expect(rels.rows.map((r) => r.field)).toEqual(["page"]);
  });

  it("is refused when the map does not match the definitions", async () => {
    const { uid } = await seed({ type: "text" }, ["x"]);
    const next = { fields: [KEEP, { name: "g", type: "text" }] };
    const bad = async (renames: Record<string, string>, def = next) => refusal(contentTypeUpdate.run({ uid, definition: def, renames }, t.ctx));
    expect((await bad({ nope: "g" })).message).toMatch(/renames do not match/);
    expect((await bad({ f: "missing" })).details.issues).toEqual(["renames.f: the definition has no field 'missing'"]);
    expect((await bad({ f: "keep" }, { fields: [KEEP] })).details.issues).toEqual(["renames.f: 'keep' already existed — its values would be overwritten"]);
    expect(((await bad({ f: "g" }, { fields: [KEEP, { name: "f", type: "text" }, { name: "g", type: "text" }] })).details.issues as string[])[0]).toMatch(/still in the definition/);
  });

  it("inside a component: values move wherever the component is used, also nested and in zones", async () => {
    await componentCreate.run({ uid: "tile", name: "tile", definition: { fields: [{ name: "title", type: "text" }, { name: "n", type: "number" }] } }, t.ctx);
    await componentCreate.run({ uid: "box", name: "box", definition: { fields: [{ name: "inner", type: "component", component: "tile", repeatable: true }] } }, t.ctx);
    await contentTypeCreate.run({ uid: "tiled", name: "tiled", definition: { fields: [{ name: "one", type: "component", component: "tile" }, { name: "b", type: "component", component: "box" }, { name: "z", type: "dynamic_zone", components: ["tile"] }] } }, t.ctx);
    const id = (
      await entryCreate.run({ typeUid: "tiled", values: { one: { title: "a", n: 1 }, b: { inner: [{ title: "b1" }, { title: "b2" }] }, z: [{ __component: "tile", title: "c" }] } }, t.ctx)
    ).entry.id;

    await componentUpdate.run({ uid: "tile", definition: { fields: [{ name: "heading", type: "text" }, { name: "n", type: "number" }] }, renames: { title: "heading" } }, t.ctx);
    const d = await detail("tiled", id);
    const v = d.entry.values as { one: unknown; b: { inner: unknown[] }; z: Array<Record<string, unknown>> };
    expect(v.one).toEqual({ heading: "a", n: 1 });
    expect(v.b.inner).toEqual([{ heading: "b1" }, { heading: "b2" }]);
    expect(v.z[0]).toMatchObject({ __component: "tile", heading: "c" });
    expect(d.removedFields).toEqual([]);
    expect(d.schemaIssues).toEqual([]);
  });

  it("a rename that is refused for another reason moves nothing", async () => {
    const { uid, entryIds } = await seed({ type: "text" }, ["abc"]);
    // renamed and, in the same change, turned into a number the value does not fit → needs confirmation
    const err = await refusal(contentTypeUpdate.run({ uid, definition: { fields: [KEEP, { name: "g", type: "number" }] }, renames: { f: "g" } }, t.ctx));
    expect(err.code).toBe("SCHEMA_CHANGE_NEEDS_CONFIRMATION");
    expect(err.details).toMatchObject({ affected: 1, byField: { g: 1 } });
    expect((await detail(uid, entryIds[0]!)).entry.values).toMatchObject({ f: "abc" });
  });
});

describe("an added field", () => {
  it("is stamped with the time it was added; original fields are not, and the stamp survives later changes and a rename", async () => {
    const { uid } = await seed({ type: "text" }, ["x"]);
    const first = await contentTypeUpdate.run({ uid, definition: { fields: [KEEP, { name: "f", type: "text" }, { name: "extra", type: "text", addedAt: "1999-01-01T00:00:00.000Z" }] } }, t.ctx);
    const byName = (def: { fields: Array<{ name: string; addedAt?: string }> }, name: string) => def.fields.find((f) => f.name === name)!;
    expect(byName(first.definition, "keep").addedAt).toBeUndefined();
    expect(byName(first.definition, "f").addedAt).toBeUndefined();
    const stamp = byName(first.definition, "extra").addedAt!;
    expect(Date.now() - Date.parse(stamp)).toBeLessThan(60_000); // the server's clock, not what the caller sent

    const second = await contentTypeUpdate.run({ uid, definition: { fields: [KEEP, { name: "f", type: "text", label: "F" }, { name: "bonus", type: "text" }] }, renames: { extra: "bonus" } }, t.ctx);
    expect(byName(second.definition, "bonus").addedAt).toBe(stamp);
    expect(byName(second.definition, "f").addedAt).toBeUndefined();
  });
});

describe("stale keys", () => {
  it("are dropped only where the stored values carried them", () => {
    const def = { fields: [{ name: "a", type: "text" }, { name: "c", type: "component", component: "k" }] } as never;
    const map = new Map([["k", { fields: [{ name: "t", type: "text" }] } as never]]);
    const stored = { a: "1", gone: "x", c: { t: "1", old: "y" } };
    expect(stripStaleKeys(def, { a: "2", gone: "x", fresh: 1, c: { t: "2", old: "y", fresh: 2 } }, map, stored)).toEqual({ a: "2", fresh: 1, c: { t: "2", fresh: 2 } });
    // without a stored copy every unknown key goes (reading)
    expect(stripStaleKeys(def, { a: "2", gone: "x", c: { t: "2", old: "y" } }, map)).toEqual({ a: "2", c: { t: "2" } });
  });
});
