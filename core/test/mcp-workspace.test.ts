/** 48-IMPL — one MCP address per workspace: /mcp/<plane>/<slug>, by token and by OAuth */
import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq, like, ne } from "drizzle-orm";
import { McpPlane, ApiGrantItem, ApiGrantLevel } from "@prina/shared";
import { buildApp } from "../src/app.js";
import { createDb } from "../src/db/client.js";
import { roles, workspaces } from "../src/db/schema/index.js";
import { mcpTokenCreate } from "../src/modules/mcp/tokens.js";
import { workspaceCreate } from "../src/modules/workspace/commands.js";
import { createSession } from "../src/modules/auth/sessions.js";
import type { CommandCtx } from "../src/commands/context.js";
import { setupTestContext, type TestContext } from "./helpers.js";

let t: TestContext;
let app: FastifyInstance;
let slugB = "";
let wsB = "";
let tokenA = "";
let tokenB = "";

const b64url = (buf: Buffer) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const initialize = (url: string, bearer?: string) =>
  app.inject({
    method: "POST",
    url,
    headers: {
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    payload: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
  });
const allGrants = Object.values(ApiGrantItem).map((item) => ({ item, level: ApiGrantLevel.Edit }));

beforeAll(async () => {
  t = await setupTestContext();
  const { db } = createDb(process.env.TEST_DATABASE_URL!);
  app = buildApp({
    env: { LOG_LEVEL: "error", NODE_ENV: "test", ADMIN_DIST_PATH: undefined, S3_REGION: "us-east-1" },
    db,
    services: t.services,
  });
  await app.ready();
  // Every test file leaves its own workspace in the shared database; past the per-install cap the
  // create below would be refused. Files run one at a time, so earlier files' workspaces are done with.
  await t.db.delete(workspaces).where(and(like(workspaces.slug, "test-%"), ne(workspaces.id, t.workspaceId)));
  slugB = `mcpws-${Date.now().toString(36)}`;
  const ws = await workspaceCreate.run({ name: "Brand B", slug: slugB }, t.ctx);
  wsB = ws.id;
  const ctxB: CommandCtx = { ...t.ctx, workspaceId: wsB };
  tokenA = (await mcpTokenCreate.run({ name: "ws-a", plane: McpPlane.Management, grants: allGrants }, t.ctx)).token;
  tokenB = (await mcpTokenCreate.run({ name: "ws-b", plane: McpPlane.Management, grants: allGrants }, ctxB)).token;
});
afterAll(async () => {
  await t.db.delete(workspaces).where(eq(workspaces.id, wsB));
  await app.close();
  await t.cleanup();
});

describe("workspace MCP addresses", () => {
  it("a token works on its own workspace's address and is turned away from another's", async () => {
    expect((await initialize(`/mcp/management/${slugB}`, tokenB)).statusCode).toBe(200);
    const other = await initialize(`/mcp/management/${slugB}`, tokenA);
    expect(other.statusCode).toBe(401);
    expect(other.headers["www-authenticate"]).toContain(`/.well-known/oauth-protected-resource/mcp/management/${slugB}"`);
    expect((await initialize(`/mcp/management/${t.workspaceSlug}`, tokenA)).statusCode).toBe(200);
  });

  it("the plain address keeps working with any token (its own workspace), and unknown slugs are 404", async () => {
    expect((await initialize("/mcp/management", tokenB)).statusCode).toBe(200);
    expect((await initialize("/mcp/management", tokenA)).statusCode).toBe(200);
    expect((await initialize("/mcp/management/no-such-workspace", tokenA)).statusCode).toBe(404);
  });

  it("publishes protected-resource metadata per workspace", async () => {
    const res = await app.inject({ method: "GET", url: `/.well-known/oauth-protected-resource/mcp/delivery/${slugB}` });
    expect(res.json().resource).toMatch(new RegExp(`/mcp/delivery/${slugB}$`));
  });
});

describe("OAuth for a workspace address", () => {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const redirect = "https://claude.ai/api/mcp/auth_callback";
  let clientId = "";
  let session = "";

  beforeAll(async () => {
    clientId = (await app.inject({ method: "POST", url: "/oauth/register", payload: { client_name: "Claude", redirect_uris: [redirect] } })).json().client_id;
    session = await t.createSession();
  });

  const approve = (fields: Record<string, string>) =>
    app.inject({
      method: "POST",
      url: "/oauth/authorize",
      headers: { cookie: `prina_session=${session}`, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ client_id: clientId, redirect_uri: redirect, code_challenge: challenge, decision: "approve", ...fields }).toString(),
    });

  it("the consent screen names the workspace the address points to", async () => {
    const resource = encodeURIComponent(`http://localhost/mcp/management/${slugB}`);
    const res = await app.inject({
      method: "GET",
      url: `/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirect)}&code_challenge=${challenge}&code_challenge_method=S256&resource=${resource}`,
      headers: { cookie: `prina_session=${session}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Brand B");
    expect(res.body).toContain(`name="workspace" value="${slugB}"`);
  });

  it("the token it issues belongs to that workspace", async () => {
    const auth = await approve({ workspace: slugB, plane: "delivery" });
    const code = new URL(auth.headers.location as string).searchParams.get("code")!;
    const tok = await app.inject({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: redirect, code_verifier: verifier }).toString(),
    });
    const access = tok.json().access_token as string;
    expect((await initialize(`/mcp/delivery/${slugB}`, access)).statusCode).toBe(200);
    expect((await initialize(`/mcp/delivery/${t.workspaceSlug}`, access)).statusCode).toBe(401);
  });

  it("refuses a role from another workspace, and people without a role in the workspace", async () => {
    const [roleA] = await t.db.select({ id: roles.id }).from(roles).where(eq(roles.workspaceId, t.workspaceId)).limit(1);
    const bad = await approve({ workspace: slugB, plane: "management", role_id: roleA!.id });
    expect(new URL(bad.headers.location as string).searchParams.get("error")).toBe("invalid_request");

    // an editor of workspace A has no role in B
    const editor = await t.createUserCtx(["editor"]);
    const editorSession = await createSession(t.db, editor.userId);
    const res = await app.inject({
      method: "GET",
      url: `/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirect)}&code_challenge=${challenge}&code_challenge_method=S256&resource=${encodeURIComponent(`http://localhost/mcp/management/${slugB}`)}`,
      headers: { cookie: `prina_session=${editorSession}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("No access to this workspace");
  });
});
