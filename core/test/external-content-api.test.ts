/**
 * External content API (IMPL-external-content-api) — management tokens open /api/content/*
 * over plain REST: same routes the admin UI uses, same command layer (RBAC/audit/workflow),
 * workspace pinned by the token.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { ActorType, ContentTypeKind, DefaultRole, McpPlane } from "@prina/shared";
import { buildApp } from "../src/app.js";
import { createDb } from "../src/db/client.js";
import { auditLog } from "../src/db/schema/index.js";
import { contentTypeCreate } from "../src/modules/content-type/commands.js";
import { entryList } from "../src/modules/entry/commands.js";
import { mcpTokenCreate, mcpTokenRevoke } from "../src/modules/mcp/tokens.js";
import { setupTestContext, type TestContext } from "./helpers.js";
import { articleDefinition } from "./fixtures.js";

let t: TestContext;
let app: FastifyInstance;
/** admin-role management token — the happy-path credential */
let adminToken: string;
/** publisher-role token — no entry create permission (RBAC check) */
let publisherToken: string;
/** delivery-plane token — must be rejected on the REST surface */
let deliveryToken: string;
/** revoked management token */
let revokedToken: string;

const authed = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
});

beforeAll(async () => {
  t = await setupTestContext();
  const { db } = createDb(process.env.TEST_DATABASE_URL!);
  app = buildApp({
    env: { LOG_LEVEL: "error", NODE_ENV: "test", ADMIN_DIST_PATH: undefined, S3_REGION: "us-east-1" },
    db,
    services: t.services,
  });

  await contentTypeCreate.run({ uid: "pd", name: "PD", definition: articleDefinition }, t.ctx);
  await contentTypeCreate.run(
    { uid: "siteinfo", name: "Site info", definition: articleDefinition, kind: ContentTypeKind.Single },
    t.ctx,
  );

  adminToken = (
    await mcpTokenCreate.run(
      { name: "ext-admin", plane: McpPlane.Management, roleId: t.roleId(DefaultRole.Admin) },
      t.ctx,
    )
  ).token;
  publisherToken = (
    await mcpTokenCreate.run(
      { name: "ext-publisher", plane: McpPlane.Management, roleId: t.roleId(DefaultRole.Publisher) },
      t.ctx,
    )
  ).token;
  deliveryToken = (
    await mcpTokenCreate.run({ name: "ext-delivery", plane: McpPlane.Delivery }, t.ctx)
  ).token;
  const revoked = await mcpTokenCreate.run(
    { name: "ext-revoked", plane: McpPlane.Management, roleId: t.roleId(DefaultRole.Admin) },
    t.ctx,
  );
  await mcpTokenRevoke.run({ id: revoked.record.id }, t.ctx);
  revokedToken = revoked.token;
});

afterAll(async () => {
  await app.close();
  await t.cleanup();
});

describe("external content API — token auth on /api/content/*", () => {
  it("full CRUD + transition round trip with a management token", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/content/pd",
      headers: authed(adminToken),
      payload: { values: { title: "From external admin" } },
    });
    expect(created.statusCode).toBe(201);
    const entryId = created.json().entry.id as string;

    const got = await app.inject({
      method: "GET",
      url: `/api/content/pd/${entryId}`,
      headers: authed(adminToken),
    });
    expect(got.statusCode).toBe(200);
    expect(got.json().entry.values.title).toBe("From external admin");

    const updated = await app.inject({
      method: "PUT",
      url: `/api/content/pd/${entryId}`,
      headers: authed(adminToken),
      payload: { values: { title: "Updated externally" } },
    });
    expect(updated.statusCode).toBe(200);

    const list = await app.inject({
      method: "GET",
      url: "/api/content/pd?filter[title]=Updated externally",
      headers: authed(adminToken),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().pagination.total).toBe(1);

    // seeded preset differs per edition (OSS 2-stage → published, EE 4-stage → via review)
    let transition = await app.inject({
      method: "POST",
      url: `/api/content/pd/${entryId}/transition`,
      headers: authed(adminToken),
      payload: { to: "review" },
    });
    if (transition.statusCode !== 200) {
      transition = await app.inject({
        method: "POST",
        url: `/api/content/pd/${entryId}/transition`,
        headers: authed(adminToken),
        payload: { to: "published" },
      });
    }
    expect(transition.statusCode).toBe(200);

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/content/pd/${entryId}`,
      // no content-type: an empty DELETE body must not trip Fastify's JSON parser
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(removed.statusCode).toBe(200);
  });

  it("audit log records the REST surface as ai actor api:<name>", async () => {
    const [row] = await t.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.workspaceId, t.workspaceId),
          eq(auditLog.actorId, "api:ext-admin"),
          eq(auditLog.action, "entry.create"),
        ),
      )
      .limit(1);
    expect(row).toBeDefined();
    expect(row!.actorType).toBe(ActorType.Ai);
  });

  it("works on a single type too", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/content/siteinfo",
      headers: authed(adminToken),
      payload: { values: { title: "Single entry" } },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().entry.id as string;
    const updated = await app.inject({
      method: "PUT",
      url: `/api/content/siteinfo/${id}`,
      headers: authed(adminToken),
      payload: { values: { title: "Single entry v2" } },
    });
    expect(updated.statusCode).toBe(200);
  });

  it("schema validation still applies (422)", async () => {
    const bad = await app.inject({
      method: "POST",
      url: "/api/content/pd",
      headers: authed(adminToken),
      payload: { values: { title: 123 } },
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("the workspace header cannot cross the token's workspace", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/content/pd",
      headers: { ...authed(adminToken), "x-prina-workspace": "does-not-exist" },
      payload: { values: { title: "Pinned workspace" } },
    });
    // header ignored — no 404 for the bogus slug, entry lands in the token's workspace
    expect(created.statusCode).toBe(201);
    const list = await entryList.run(
      { typeUid: "pd", filter: { title: "Pinned workspace" } },
      t.ctx,
    );
    expect(list.pagination.total).toBe(1);
  });

  it("RBAC applies — publisher-bound token cannot create (403)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/content/pd",
      headers: authed(publisherToken),
      payload: { values: { title: "Should be denied" } },
    });
    expect(res.statusCode).toBe(403);
  });

  it("rejects a delivery-plane token (401)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/content/pd",
      headers: authed(deliveryToken),
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a revoked token (401)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/content/pd",
      headers: authed(revokedToken),
    });
    expect(res.statusCode).toBe(401);
  });

  it("tokens open /api/content/* only — other API paths stay 401", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/content-types",
      headers: authed(adminToken),
    });
    expect(res.statusCode).toBe(401);
  });

  it("unauthenticated requests are still rejected (401)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/content/pd",
      headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(401);
  });
});
