/** REST adapter E2E — T1.3 DoD: type definition API → CRUD with immediate schema validation */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createDb } from "../src/db/client.js";
import { setupTestContext, type TestContext } from "./helpers.js";
import { articleDefinition } from "./fixtures.js";

let t: TestContext;
let app: FastifyInstance;
let headers: Record<string, string>;

beforeAll(async () => {
  t = await setupTestContext();
  const { db } = createDb(process.env.TEST_DATABASE_URL!);
  app = buildApp({
    env: {
      LOG_LEVEL: "error",
      NODE_ENV: "test",
      ADMIN_DIST_PATH: undefined,
      S3_REGION: "us-east-1",
    },
    db,
    services: t.services,
  });
  headers = {
    "x-prina-workspace": t.workspaceSlug,
    "x-prina-actor": `human:${t.userId}`,
    "content-type": "application/json",
  };
});
afterAll(async () => {
  await app.close();
  await t.cleanup();
});

describe("REST API (Phase 1 adapter)", () => {
  it("/health returns DB status (T0.2 DoD)", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok", db: "ok" });
  });

  it("type creation → immediate CRUD + validation (T1.3 DoD)", async () => {
    const createType = await app.inject({
      method: "POST",
      url: "/api/content-types",
      headers,
      payload: { uid: "post", name: "포스트", definition: articleDefinition },
    });
    expect(createType.statusCode).toBe(201);

    // valid create
    const ok = await app.inject({
      method: "POST",
      url: "/api/content/post",
      headers,
      payload: { values: { title: "REST로 작성" } },
    });
    expect(ok.statusCode).toBe(201);
    const entryId = ok.json().entry.id as string;

    // schema violation returns 422
    const bad = await app.inject({
      method: "POST",
      url: "/api/content/post",
      headers,
      payload: { values: { title: 123 } },
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.code).toBe("VALIDATION_ERROR");

    // get, update, list
    const got = await app.inject({
      method: "GET",
      url: `/api/content/post/${entryId}`,
      headers,
    });
    expect(got.json().entry.values.title).toBe("REST로 작성");

    const updated = await app.inject({
      method: "PUT",
      url: `/api/content/post/${entryId}`,
      headers,
      payload: { values: { title: "수정됨" } },
    });
    expect(updated.statusCode).toBe(200);

    const list = await app.inject({
      method: "GET",
      url: "/api/content/post?filter[title]=수정됨",
      headers,
    });
    expect(list.json().pagination.total).toBe(1);

    // transition — the seeded preset differs per edition (OSS 2-stage = straight to published, EE 4-stage = via review)
    let transition = await app.inject({
      method: "POST",
      url: `/api/content/post/${entryId}/transition`,
      headers,
      payload: { to: "review" },
    });
    if (transition.statusCode !== 200) {
      transition = await app.inject({
        method: "POST",
        url: `/api/content/post/${entryId}/transition`,
        headers,
        payload: { to: "published" },
      });
    }
    expect(["review", "published"]).toContain(transition.json().entry.status);

    // version history routes are EE — verified in test/ee/gate.test.ts (IMPL-ee-boundary)
  });

  it("unknown type returns 404", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/content/ghost",
      headers,
    });
    expect(res.statusCode).toBe(404);
  });

  it("OpenAPI co-derives the type schema (T1.3 ②)", async () => {
    const res = await app.inject({ method: "GET", url: "/openapi.json", headers });
    expect(res.statusCode).toBe(200);
    const doc = res.json();
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.components.schemas.post_values).toBeDefined();
    expect(doc.paths["/api/content/post"]).toBeDefined();
    // fields derived by the schema pipeline are reflected as-is
    expect(doc.components.schemas.post_values.properties.title).toBeDefined();
  });
});
