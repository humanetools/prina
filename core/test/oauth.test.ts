/** OAuth 2.1 authorization server (§2.6) — discovery → DCR → consent → code+PKCE → MCP token */
import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createDb } from "../src/db/client.js";
import { setupTestContext, type TestContext } from "./helpers.js";

let t: TestContext;
let app: FastifyInstance;

const b64url = (buf: Buffer) =>
  buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

beforeAll(async () => {
  t = await setupTestContext();
  const { db } = createDb(process.env.TEST_DATABASE_URL!);
  app = buildApp({
    env: { LOG_LEVEL: "error", NODE_ENV: "test", ADMIN_DIST_PATH: undefined, S3_REGION: "us-east-1" },
    db,
    services: t.services,
  });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await t.cleanup();
});

describe("OAuth 2.1 for MCP", () => {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const redirect = "https://claude.ai/api/mcp/auth_callback";
  let clientId: string;
  let code: string;

  it("serves both discovery documents", async () => {
    const as = await app.inject({ method: "GET", url: "/.well-known/oauth-authorization-server" });
    expect(as.statusCode).toBe(200);
    const doc = as.json();
    expect(doc.code_challenge_methods_supported).toEqual(["S256"]);
    expect(doc.registration_endpoint).toContain("/oauth/register");

    const pr = await app.inject({
      method: "GET",
      url: "/.well-known/oauth-protected-resource/mcp/management",
    });
    expect(pr.json().resource).toContain("/mcp/management");
  });

  it("MCP 401 gives a resource_metadata hint", async () => {
    const res = await app.inject({ method: "POST", url: "/mcp/management", payload: {} });
    expect(res.statusCode).toBe(401);
    expect(res.headers["www-authenticate"]).toContain("oauth-protected-resource/mcp/management");
  });

  it("DCR: dynamically registers a client", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/oauth/register",
      payload: { client_name: "Claude", redirect_uris: [redirect] },
    });
    expect(res.statusCode).toBe(201);
    clientId = res.json().client_id;
    expect(clientId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("DCR: rejects http (non-local) redirects", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/oauth/register",
      payload: { client_name: "bad", redirect_uris: ["http://evil.example/cb"] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("authorize: shows the login screen to a logged-out browser", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirect)}&code_challenge=${challenge}&code_challenge_method=S256&state=xyz`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Sign in to Prina");
  });

  it("authorize: redirects with a code on approval", async () => {
    // Mimic the test helper admin session cookie — x-prina-actor does not work on /oauth, so create the session directly
    const session = await t.createSession();
    const res = await app.inject({
      method: "POST",
      url: "/oauth/authorize",
      headers: { cookie: `prina_session=${session}`, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirect,
        code_challenge: challenge,
        state: "xyz",
        plane: "delivery",
        decision: "approve",
      }).toString(),
    });
    expect(res.statusCode).toBe(302);
    const loc = new URL(res.headers.location as string);
    expect(loc.origin + loc.pathname).toBe(redirect);
    expect(loc.searchParams.get("state")).toBe("xyz");
    code = loc.searchParams.get("code")!;
    expect(code).toBeTruthy();
  });

  it("token: rejects a wrong verifier", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        code_verifier: "wrong-verifier-wrong-verifier-wrong-verifier",
      }).toString(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_grant");
  });

  it("token: code+PKCE exchange yields an MCP token, and that token can MCP initialize", async () => {
    // Issue a fresh code so the failed exchange above does not consume it
    const session = await t.createSession();
    const auth = await app.inject({
      method: "POST",
      url: "/oauth/authorize",
      headers: { cookie: `prina_session=${session}`, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirect,
        code_challenge: challenge,
        state: "s2",
        plane: "delivery",
        decision: "approve",
      }).toString(),
    });
    const freshCode = new URL(auth.headers.location as string).searchParams.get("code")!;

    const res = await app.inject({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        grant_type: "authorization_code",
        code: freshCode,
        client_id: clientId,
        redirect_uri: redirect,
        code_verifier: verifier,
      }).toString(),
    });
    expect(res.statusCode).toBe(200);
    const tok = res.json();
    expect(tok.token_type).toBe("bearer");
    expect(tok.access_token).toMatch(/^pmt_dlv_/);

    // replay protection — exchanging the same code again is rejected
    const replay = await app.inject({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        grant_type: "authorization_code",
        code: freshCode,
        client_id: clientId,
        code_verifier: verifier,
      }).toString(),
    });
    expect(replay.statusCode).toBe(400);

    // actual MCP initialize with the issued token
    const init = await app.inject({
      method: "POST",
      url: "/mcp/delivery",
      headers: {
        authorization: `Bearer ${tok.access_token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      payload: {
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } },
      },
    });
    expect(init.statusCode).toBe(200);
  });
});
