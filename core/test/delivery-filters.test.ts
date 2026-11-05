/** Public list filtering — Strapi-style filters[field][$op]=value on GET /delivery/:type */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createDb } from "../src/db/client.js";
import { contentTypeCreate } from "../src/modules/content-type/commands.js";
import { entryCreate } from "../src/modules/entry/commands.js";
import { publishEntry, setupTestContext, type TestContext } from "./helpers.js";

let t: TestContext;
let app: FastifyInstance;
let tagA: string;
let tagB: string;

async function makePublished(typeUid: string, values: Record<string, unknown>): Promise<string> {
  const r = await entryCreate.run({ typeUid, values }, t.ctx);
  await publishEntry(t.ctx, typeUid, r.entry.id);
  return r.entry.id;
}

beforeAll(async () => {
  t = await setupTestContext();
  const { db } = createDb(process.env.TEST_DATABASE_URL!);
  app = buildApp({
    env: { LOG_LEVEL: "error", NODE_ENV: "test", ADMIN_DIST_PATH: undefined, S3_REGION: "us-east-1" },
    db,
    services: t.services,
  });
  await contentTypeCreate.run(
    { uid: "tag", name: "Tag", definition: { displayField: "name", fields: [{ name: "name", type: "text" }] } },
    t.ctx,
  );
  tagA = await makePublished("tag", { name: "alpha" });
  tagB = await makePublished("tag", { name: "beta" });
  await contentTypeCreate.run(
    {
      uid: "post",
      name: "Post",
      definition: {
        displayField: "title",
        fields: [
          { name: "title", type: "text" },
          { name: "minutes", type: "number" },
          { name: "featured", type: "boolean" },
          { name: "body", type: "richtext" },
          { name: "tags", type: "relation", target: "tag", relationKind: "manyToMany" },
        ],
      },
    },
    t.ctx,
  );
  await makePublished("post", { title: "Alpha post", minutes: 3, featured: true, tags: [tagA] });
  await makePublished("post", { title: "Beta post", minutes: 7, featured: false, tags: [tagB] });
  await makePublished("post", { title: "Gamma note", minutes: 11, featured: true, tags: [tagA, tagB] });
  // minutes intentionally missing — must not break numeric casts
  await makePublished("post", { title: "No minutes", featured: false });
});
afterAll(async () => {
  await app.close();
  await t.cleanup();
});

async function titles(qs: string): Promise<string[]> {
  const res = await app.inject({ method: "GET", url: `/delivery/post?ws=${t.workspaceSlug}&${qs}` });
  expect(res.statusCode, qs).toBe(200);
  return (res.json() as { items: Array<{ values: { title: string } }> }).items
    .map((i) => i.values.title)
    .sort();
}

describe("GET /delivery/:type filters", () => {
  it("$eq on text, boolean (bare key = $eq), and total header reflects the filter", async () => {
    expect(await titles("filters[title][$eq]=Alpha post")).toEqual(["Alpha post"]);
    expect(await titles("filters[featured]=true")).toEqual(["Alpha post", "Gamma note"]);
    const res = await app.inject({
      method: "GET",
      url: `/delivery/post?ws=${t.workspaceSlug}&filters[featured]=true`,
    });
    expect(res.headers["x-total-count"]).toBe("2");
  });

  it("number ops guard entries missing the field instead of blowing up the cast", async () => {
    expect(await titles("filters[minutes][$gte]=7")).toEqual(["Beta post", "Gamma note"]);
    expect(await titles("filters[minutes][$lt]=7")).toEqual(["Alpha post"]);
    expect(await titles("filters[minutes][$in]=3,11")).toEqual(["Alpha post", "Gamma note"]);
  });

  it("$contains / $ne / $null on text", async () => {
    expect(await titles("filters[title][$contains]=post")).toEqual(["Alpha post", "Beta post"]);
    expect(await titles("filters[title][$ne]=Alpha post")).toEqual(["Beta post", "Gamma note", "No minutes"]);
    expect(await titles("filters[minutes][$null]=true")).toEqual(["No minutes"]);
    expect(await titles("filters[minutes][$null]=false")).toEqual(["Alpha post", "Beta post", "Gamma note"]);
  });

  it("relation membership on a has-many field", async () => {
    expect(await titles(`filters[tags][$eq]=${tagA}`)).toEqual(["Alpha post", "Gamma note"]);
    expect(await titles(`filters[tags][$in]=${tagA},${tagB}`)).toEqual(["Alpha post", "Beta post", "Gamma note"]);
    expect(await titles(`filters[tags][$ne]=${tagA}`)).toEqual(["Beta post"]);
  });

  it("multiple filters AND together and compose with paging", async () => {
    expect(await titles("filters[featured]=true&filters[minutes][$gte]=5")).toEqual(["Gamma note"]);
    const res = await app.inject({
      method: "GET",
      url: `/delivery/post?ws=${t.workspaceSlug}&filters[featured]=true&page=1&pageSize=1`,
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { items: unknown[] }).items.length).toBe(1);
    expect(res.headers["x-total-count"]).toBe("2");
  });

  it("bad field, bad operator, unfilterable field, bad number → 422", async () => {
    for (const qs of [
      "filters[nosuch][$eq]=x",
      "filters[title][$bogus]=x",
      "filters[body][$eq]=x",
      "filters[minutes][$eq]=abc",
      "filters[featured][$eq]=maybe",
    ]) {
      const res = await app.inject({ method: "GET", url: `/delivery/post?ws=${t.workspaceSlug}&${qs}` });
      expect(res.statusCode, qs).toBe(422);
      expect((res.json() as { error: { code: string } }).error.code).toBe("VALIDATION_ERROR");
    }
  });
});
