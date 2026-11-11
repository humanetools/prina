/**
 * External content API (IMPL-external-content-api) — management tokens open /api/content/*
 * over plain REST: same routes the admin UI uses, same command layer (RBAC/audit/workflow),
 * workspace pinned by the token.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { ActorType, ApiGrantItem, ApiGrantLevel, ApiScope, ApiScopeLevel, ContentTypeKind, DefaultRole, McpPlane } from "@prina/shared";
import { requiredGrantFor } from "../src/http/api-grants.js";
import { requiredScopeFor } from "../src/http/api-scopes.js";
import { buildApp } from "../src/app.js";
import { createDb } from "../src/db/client.js";
import { auditLog, permissions, roles } from "../src/db/schema/index.js";
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

  it("a legacy token (no scopes) keeps its original surface — other groups are 403 SCOPE_DENIED", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/content-types",
      headers: authed(adminToken),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("SCOPE_DENIED");
    expect(res.json().error.details).toEqual({ scope: "schema", required: "read", granted: null });
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

describe("access-token scopes (20-IMPL) — resource group × read/edit", () => {
  let readSchema: string;
  let fullDev: string;

  beforeAll(async () => {
    readSchema = (
      await mcpTokenCreate.run(
        { name: "ext-schema-ro", plane: McpPlane.Management, roleId: t.roleId(DefaultRole.Admin), scopes: { [ApiScope.Schema]: ApiScopeLevel.Read } },
        t.ctx,
      )
    ).token;
    fullDev = (
      await mcpTokenCreate.run(
        {
          name: "ext-full",
          plane: McpPlane.Management,
          roleId: t.roleId(DefaultRole.Admin),
          scopes: {
            [ApiScope.Content]: ApiScopeLevel.Edit,
            [ApiScope.Schema]: ApiScopeLevel.Edit,
            [ApiScope.Assets]: ApiScopeLevel.Edit,
            [ApiScope.Locales]: ApiScopeLevel.Edit,
            [ApiScope.Templates]: ApiScopeLevel.Edit,
            [ApiScope.Taxonomies]: ApiScopeLevel.Edit,
          },
        },
        t.ctx,
      )
    ).token;
  });

  it("read scope allows GET and refuses writes with the required/granted levels in the error", async () => {
    const ok = await app.inject({ method: "GET", url: "/api/content-types", headers: authed(readSchema) });
    expect(ok.statusCode).toBe(200);
    const denied = await app.inject({
      method: "POST",
      url: "/api/content-types",
      headers: authed(readSchema),
      payload: { uid: "nope", name: "Nope", definition: { fields: [{ name: "t", type: "text" }] } },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe("SCOPE_DENIED");
    expect(denied.json().error.details).toEqual({ scope: "schema", required: "edit", granted: "read" });
    // content stays closed to this token entirely
    const other = await app.inject({ method: "GET", url: "/api/content/pd", headers: authed(readSchema) });
    expect(other.statusCode).toBe(403);
    expect(other.json().error.details.granted).toBeNull();
  });

  it("edit scopes open CTB, components, locales, templates, assets and taxonomies to the token", async () => {
    const ct = await app.inject({
      method: "POST",
      url: "/api/content-types",
      headers: authed(fullDev),
      payload: { uid: "ext_page", name: "Ext page", definition: { fields: [{ name: "title", type: "text", required: true }], displayField: "title" } },
    });
    expect(ct.statusCode).toBe(201);
    const comp = await app.inject({
      method: "POST",
      url: "/api/components",
      headers: authed(fullDev),
      payload: { uid: "ext.block", name: "Ext block", definition: { fields: [{ name: "heading", type: "text" }] } },
    });
    expect(comp.statusCode).toBe(201);
    const loc = await app.inject({ method: "POST", url: "/api/locales", headers: authed(fullDev), payload: { code: "fr", name: "Français" } });
    expect(loc.statusCode).toBe(201);
    const locList = await app.inject({ method: "GET", url: "/api/locales", headers: authed(fullDev) });
    expect(locList.statusCode).toBe(200);
    expect(locList.json().some((l: { code: string }) => l.code === "fr")).toBe(true);
    const tpl = await app.inject({
      method: "PUT",
      url: "/api/templates/ext_page",
      headers: authed(fullDev),
      payload: { liquid: "<h1>{{ values.title }}</h1>", css: "" },
    });
    expect([200, 201]).toContain(tpl.statusCode);
    const upload = await app.inject({
      method: "POST",
      url: "/api/assets/uploads",
      headers: authed(fullDev),
      payload: { filename: "a.png", mime: "image/png", size: 1234 },
    });
    expect(upload.statusCode).toBe(201);
    const tax = await app.inject({ method: "GET", url: "/api/taxonomies", headers: authed(fullDev) });
    expect(tax.statusCode).toBe(200);
    // cleanup
    await app.inject({ method: "DELETE", url: "/api/locales/fr", headers: authed(fullDev) });
    await app.inject({ method: "DELETE", url: "/api/components/ext.block", headers: authed(fullDev) });
    await app.inject({ method: "DELETE", url: "/api/content-types/ext_page", headers: authed(fullDev) });
  });

  it("scope ≠ permission — a scoped token still hits the role's 403 FORBIDDEN", async () => {
    const pubSchema = (
      await mcpTokenCreate.run(
        { name: "ext-pub-schema", plane: McpPlane.Management, roleId: t.roleId(DefaultRole.Publisher), scopes: { [ApiScope.Schema]: ApiScopeLevel.Edit } },
        t.ctx,
      )
    ).token;
    const res = await app.inject({
      method: "POST",
      url: "/api/content-types",
      headers: authed(pubSchema),
      payload: { uid: "pub_nope", name: "Nope", definition: { fields: [{ name: "t", type: "text" }] } },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).not.toBe("SCOPE_DENIED");
  });

  it("identity / admin-of-admin paths are closed to every token", async () => {
    for (const url of ["/api/users", "/api/roles", "/api/mcp/tokens", "/api/workspace-settings", "/api/auth/me"]) {
      const res = await app.inject({ method: "GET", url, headers: authed(fullDev) });
      expect(res.statusCode, url).toBe(403);
      expect(res.json().error.details, url).toEqual({ scope: null });
    }
  });

  it("issuing: scopes are management-only; {} means MCP-only (every REST path is SCOPE_DENIED)", async () => {
    await expect(
      mcpTokenCreate.run({ name: "dlv-scoped", plane: McpPlane.Delivery, scopes: { [ApiScope.Content]: ApiScopeLevel.Read } }, t.ctx),
    ).rejects.toThrow(/management tokens only/);
    const mcpOnly = (
      await mcpTokenCreate.run({ name: "mgmt-mcp-only", plane: McpPlane.Management, roleId: t.roleId(DefaultRole.Admin), scopes: {} }, t.ctx)
    ).token;
    const res = await app.inject({ method: "GET", url: "/api/content/pd", headers: authed(mcpOnly) });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.details).toEqual({ scope: "content", required: "read", granted: null });
  });

  it("issuing: a revoked token's name cannot be reused (409, not 500)", async () => {
    const r = await mcpTokenCreate.run({ name: "reuse-me", plane: McpPlane.Management, roleId: t.roleId(DefaultRole.Admin) }, t.ctx);
    await mcpTokenRevoke.run({ id: r.record.id }, t.ctx);
    await expect(
      mcpTokenCreate.run({ name: "reuse-me", plane: McpPlane.Management, roleId: t.roleId(DefaultRole.Admin) }, t.ctx),
    ).rejects.toThrow(/revoked — names are permanent/);
  });

  it("every registered /api route has a scope decision (open in a group or explicitly closed)", () => {
    const CLOSED = ["/api/auth", "/api/setup", "/api/users", "/api/roles", "/api/mcp", "/api/ai", "/api/workspaces", "/api/workspace-settings", "/api/license", "/api/tunnel", "/api/workflow", "/api/delivery", "/api/openapi", "/api/health"];
    const undecided = app.routeTable
      .filter((r) => r.url.startsWith("/api/"))
      .filter((r) => !requiredScopeFor(r.method, r.url) && !CLOSED.some((p) => r.url === p || r.url.startsWith(`${p}/`)))
      .map((r) => `${r.method} ${r.url}`);
    expect(undecided).toEqual([]);
  });
});

describe("access-token grants (20-IMPL custom mode) — area ▸ item ▸ level, per type, no role", () => {
  it("a grant token reaches exactly its items; entries can be narrowed to a type; the grants are its permissions", async () => {
    const tok = (
      await mcpTokenCreate.run(
        {
          name: "ext-grants",
          plane: McpPlane.Management,
          grants: [
            { item: ApiGrantItem.Entries, level: ApiGrantLevel.Edit, types: ["pd"] },
            { item: ApiGrantItem.Locales, level: ApiGrantLevel.Read },
            { item: ApiGrantItem.ContentTypes, level: ApiGrantLevel.Edit },
          ],
        },
        t.ctx,
      )
    ).token;
    // entries on the granted type: full CRUD through the token's own permission rows (no role)
    const created = await app.inject({ method: "POST", url: "/api/content/pd", headers: authed(tok), payload: { values: { title: "grant-made" } } });
    expect(created.statusCode).toBe(201);
    const id = created.json().entry.id;
    expect((await app.inject({ method: "GET", url: `/api/content/pd/${id}`, headers: authed(tok) })).statusCode).toBe(200);
    // another type → SCOPE_DENIED with the type in the details
    const other = await app.inject({ method: "GET", url: "/api/content/siteinfo", headers: authed(tok) });
    expect(other.statusCode).toBe(403);
    expect(other.json().error.details).toMatchObject({ item: "entries", required: "read", typeUid: "siteinfo", granted: { level: "edit", types: ["pd"] } });
    // publish is a separate item → not granted
    const pub = await app.inject({ method: "POST", url: `/api/content/pd/${id}/transition`, headers: authed(tok), payload: { to: "published" } });
    expect(pub.statusCode).toBe(403);
    expect(pub.json().error.details.item).toBe("publish");
    // locales read ok, write denied at the grant level
    expect((await app.inject({ method: "GET", url: "/api/locales", headers: authed(tok) })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/locales", headers: authed(tok), payload: { code: "xx", name: "X" } })).statusCode).toBe(403);
    // content types edit → CTB works with no role at all; schema.org lookups ride along
    const ct = await app.inject({ method: "POST", url: "/api/content-types", headers: authed(tok), payload: { uid: "grant_ct", name: "Grant CT", definition: { fields: [{ name: "t", type: "text" }] } } });
    expect(ct.statusCode).toBe(201);
    expect((await app.inject({ method: "GET", url: "/api/schema-org/types", headers: authed(tok) })).statusCode).toBe(200);
    // closed paths stay closed
    const users = await app.inject({ method: "GET", url: "/api/users", headers: authed(tok) });
    expect(users.statusCode).toBe(403);
    expect(users.json().error.details).toEqual({ item: null });
    await app.inject({ method: "DELETE", url: "/api/content-types/grant_ct", headers: authed(tok) });
    await app.inject({ method: "DELETE", url: `/api/content/pd/${id}`, headers: authed(tok) });
  });

  it("issuer ceiling — a user cannot grant what they cannot do; edit-only and typed rules are validated", async () => {
    // Only the admin role (subject "*") is seeded with token issuance, so build a limited issuer:
    // may issue tokens + edit CTB + read content, but cannot publish or touch locales.
    const [limited] = await t.db.insert(roles).values({ workspaceId: t.workspaceId, name: "token-issuer-limited", description: "test" }).returning();
    await t.db.insert(permissions).values([
      { workspaceId: t.workspaceId, roleId: limited!.id, action: "*", subject: "system:mcp", fields: null, locales: null },
      { workspaceId: t.workspaceId, roleId: limited!.id, action: "*", subject: "system:ctb", fields: null, locales: null },
      { workspaceId: t.workspaceId, roleId: limited!.id, action: "read", subject: "content:*", fields: null, locales: null },
    ]);
    const { ctx: issuer } = await t.createUserCtx(["token-issuer-limited"]);
    // more than the issuer has → refused, naming what exceeded
    await expect(
      mcpTokenCreate.run({ name: "too-strong", plane: McpPlane.Management, grants: [{ item: ApiGrantItem.Publish, level: ApiGrantLevel.Edit }] }, issuer),
    ).rejects.toThrow(/cannot grant more than you have/);
    await expect(
      mcpTokenCreate.run({ name: "too-strong-2", plane: McpPlane.Management, grants: [{ item: ApiGrantItem.Entries, level: ApiGrantLevel.Edit, types: ["pd"] }] }, issuer),
    ).rejects.toThrow(/cannot grant more than you have/);
    // within the issuer's own rights → issued
    const ok = await mcpTokenCreate.run(
      { name: "within-ceiling", plane: McpPlane.Management, grants: [{ item: ApiGrantItem.ContentTypes, level: ApiGrantLevel.Edit }, { item: ApiGrantItem.Entries, level: ApiGrantLevel.Read }] },
      issuer,
    );
    expect(ok.token.startsWith("pmt_mgmt_")).toBe(true);
    await expect(
      mcpTokenCreate.run({ name: "bad-level", plane: McpPlane.Management, grants: [{ item: ApiGrantItem.Publish, level: ApiGrantLevel.Read }] }, t.ctx),
    ).rejects.toThrow();
    await expect(
      mcpTokenCreate.run({ name: "bad-types", plane: McpPlane.Management, grants: [{ item: ApiGrantItem.Assets, level: ApiGrantLevel.Read, types: ["pd"] }] }, t.ctx),
    ).rejects.toThrow();
    await expect(
      mcpTokenCreate.run({ name: "both-modes", plane: McpPlane.Management, roleId: t.roleId(DefaultRole.Admin), scopes: { [ApiScope.Content]: ApiScopeLevel.Edit }, grants: [{ item: ApiGrantItem.Assets, level: ApiGrantLevel.Read }] }, t.ctx),
    ).rejects.toThrow(/Choose one mode/);
  });

  it("every registered /api route has a grant decision too (open in an item or explicitly closed)", () => {
    const CLOSED = ["/api/auth", "/api/setup", "/api/users", "/api/roles", "/api/mcp", "/api/ai", "/api/workspaces", "/api/workspace-settings", "/api/license", "/api/tunnel", "/api/workflow", "/api/openapi", "/api/health"];
    const undecided = app.routeTable
      .filter((r) => r.url.startsWith("/api/"))
      .filter((r) => !requiredGrantFor(r.method, r.url) && !CLOSED.some((p) => r.url === p || r.url.startsWith(`${p}/`)))
      .map((r) => `${r.method} ${r.url}`);
    expect(undecided).toEqual([]);
  });
});

