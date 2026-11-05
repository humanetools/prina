/** Delivery search endpoint (todo §0.18) — frontend-facing published-content search */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createDb } from "../src/db/client.js";
import { contentTypeCreate } from "../src/modules/content-type/commands.js";
import { entryCreate } from "../src/modules/entry/commands.js";
import { publishEntry, setupTestContext, type TestContext } from "./helpers.js";

let t: TestContext;
let app: FastifyInstance;

beforeAll(async () => {
  t = await setupTestContext();
  const { db } = createDb(process.env.TEST_DATABASE_URL!);
  app = buildApp({
    env: { LOG_LEVEL: "error", NODE_ENV: "test", ADMIN_DIST_PATH: undefined, S3_REGION: "us-east-1" },
    db,
    services: t.services,
  });
  await contentTypeCreate.run(
    {
      uid: "guide",
      name: "Guide",
      definition: {
        displayField: "title",
        fields: [{ name: "title", type: "text", required: true }],
      },
    },
    t.ctx,
  );
  const hit = await entryCreate.run(
    { typeUid: "guide", values: { title: "Industrial camera calibration guide" } },
    t.ctx,
  );
  await publishEntry(t.ctx, "guide", hit.entry.id);
  // draft stays invisible to the public plane
  await entryCreate.run(
    { typeUid: "guide", values: { title: "Draft camera notes (unpublished)" } },
    t.ctx,
  );
});
afterAll(async () => {
  await app.close();
  await t.cleanup();
});

describe("GET /delivery/:type pagination (public list)", () => {
  it("pages with page/pageSize and reports the total in headers", async () => {
    for (let i = 0; i < 3; i++) {
      const e = await entryCreate.run(
        { typeUid: "guide", values: { title: `Paging guide ${i}` } },
        t.ctx,
      );
      await publishEntry(t.ctx, "guide", e.entry.id);
    }
    const p1 = await app.inject({
      method: "GET",
      url: `/delivery/guide?ws=${t.workspaceSlug}&page=1&pageSize=2`,
    });
    expect(p1.statusCode).toBe(200);
    expect(p1.headers["x-total-count"]).toBe("4"); // 3 + the search fixture entry
    expect((p1.json() as { items: unknown[] }).items.length).toBe(2);
    const p2 = await app.inject({
      method: "GET",
      url: `/delivery/guide?ws=${t.workspaceSlug}&page=2&pageSize=2`,
    });
    expect((p2.json() as { items: unknown[] }).items.length).toBe(2);
    const p3 = await app.inject({
      method: "GET",
      url: `/delivery/guide?ws=${t.workspaceSlug}&page=3&pageSize=2`,
    });
    expect((p3.json() as { items: unknown[] }).items.length).toBe(0);
    // no params → old behaviour (single page, all rows up to 100)
    const all = await app.inject({ method: "GET", url: `/delivery/guide?ws=${t.workspaceSlug}` });
    expect((all.json() as { items: unknown[] }).items.length).toBe(4);
  });

  // Unvalidated numbers rode into OFFSET as Infinity/fractions and came back as 500s (2026-08-24)
  it("garbage page/pageSize falls back to defaults instead of a 500", async () => {
    for (const qs of ["page=1e300", "page=2.5&pageSize=3", "page=abc", "pageSize=-1"]) {
      const res = await app.inject({ method: "GET", url: `/delivery/guide?ws=${t.workspaceSlug}&${qs}` });
      expect(res.statusCode, qs).toBe(200);
    }
  });
});

describe("GET /delivery/search", () => {
  it("returns published hits only (FTS fallback without embeddings)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/delivery/search?q=camera&ws=${t.workspaceSlug}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { query: string; hits: Array<{ title: unknown; matchedBy: string }> };
    expect(body.query).toBe("camera");
    expect(body.hits.length).toBe(1);
    expect(String(body.hits[0]!.title)).toContain("calibration");
    expect(body.hits[0]!.matchedBy).toBe("fts");
  });

  it("rejects a missing query", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/delivery/search?ws=${t.workspaceSlug}`,
    });
    expect(res.statusCode).toBe(400);
  });

  // limit=abc → LIMIT NaN, limit=-5 → LIMIT -5 — both were Postgres errors (2026-08-24)
  it("garbage limit falls back to the default instead of a 500", async () => {
    for (const limit of ["abc", "-5", "1e300"]) {
      const res = await app.inject({
        method: "GET",
        url: `/delivery/search?q=camera&ws=${t.workspaceSlug}&limit=${limit}`,
      });
      expect(res.statusCode, `limit=${limit}`).toBe(200);
    }
  });
});
