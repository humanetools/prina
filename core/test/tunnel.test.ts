/** IMPL-public-tunnel — /api/tunnel relay: ticket custody, state persistence, cloudflared lifecycle */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createDb } from "../src/db/client.js";
import { readTunnelState, type TunnelRuntime } from "../src/modules/tunnel/service.js";
import { setupTestContext, type TestContext } from "./helpers.js";

let t: TestContext;
let app: FastifyInstance;
let db: ReturnType<typeof createDb>["db"];
let headers: Record<string, string>;

/** Records lifecycle calls instead of spawning cloudflared */
const runtime: TunnelRuntime & { started: string[]; stops: number } = {
  available: true,
  started: [],
  stops: 0,
  running() {
    return this.started.length > this.stops;
  },
  start(token: string) {
    this.started.push(token);
  },
  stop() {
    this.stops += 1;
  },
  lastError: () => null,
};

/** Emulates the tunnel service endpoints on prina-license */
let serviceDown = false;
const fakeService: typeof fetch = async (input, init) => {
  if (serviceDown) throw new Error("network down");
  const url = String(input);
  const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};
  const json = (status: number, payload: unknown) =>
    new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
  if (url.endsWith("/v1/tunnels/code")) return json(200, { ok: true });
  if (url.endsWith("/v1/tunnels/verify")) {
    return body.code === "123"
      ? json(200, { ticket: "ticket-1" })
      : json(401, { error: { code: "CODE_MISMATCH", message: "That code is not right" } });
  }
  if (url.includes("/v1/tunnels/available")) return json(200, { available: true });
  if (url.endsWith("/v1/tunnels/remote-admin")) {
    return json(200, { host: "acme.prina.app", remoteAdmin: body.enabled });
  }
  if (url.endsWith("/v1/tunnels")) {
    if (body.ticket !== "ticket-1") return json(401, { error: { code: "TICKET_INVALID", message: "no" } });
    return json(201, {
      host: `${body.subdomain}.prina.app`,
      token: "cf-connector-token",
      ownerToken: "owner-secret",
      expiresAt: Date.now() + 365 * 86_400_000,
    });
  }
  return json(404, {});
};

beforeAll(async () => {
  t = await setupTestContext();
  db = createDb(process.env.TEST_DATABASE_URL!).db;
  app = buildApp({
    env: { LOG_LEVEL: "error", NODE_ENV: "test", ADMIN_DIST_PATH: undefined, S3_REGION: "us-east-1" },
    db,
    services: t.services,
    tunnel: { runtime, serviceUrl: "https://tunnel.test", localPort: 3000, fetchImpl: fakeService },
  });
  headers = { "x-prina-actor": `human:${t.userId}`, "content-type": "application/json" };
});
afterAll(async () => {
  await app.close();
  await t.cleanup();
});

const EMAIL = "dev@acme.com";

describe("/api/tunnel relay", () => {
  it("requires auth", async () => {
    const res = await app.inject({ method: "GET", url: "/api/tunnel/status" });
    expect(res.statusCode).toBe(401);
  });

  it("create without a verified ticket is rejected", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/tunnel/create", headers,
      payload: { email: EMAIL, subdomain: "acme" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("TICKET_INVALID");
  });

  it("code → verify keeps the ticket server-side and answers ok only", async () => {
    const code = await app.inject({
      method: "POST", url: "/api/tunnel/code", headers,
      payload: { email: EMAIL, consent: true },
    });
    expect(code.statusCode).toBe(200);

    const bad = await app.inject({
      method: "POST", url: "/api/tunnel/verify", headers,
      payload: { email: EMAIL, code: "999" },
    });
    expect(bad.statusCode).toBe(401);

    const ok = await app.inject({
      method: "POST", url: "/api/tunnel/verify", headers,
      payload: { email: EMAIL, code: "123" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true }); // the ticket itself never reaches the browser
  });

  it("create persists state, starts cloudflared, and never exposes the token", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/tunnel/create", headers,
      payload: { email: EMAIL, subdomain: "acme" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().host).toBe("acme.prina.app");
    expect(res.json().token).toBeUndefined();
    expect(runtime.started).toEqual(["cf-connector-token"]);

    const state = await readTunnelState(db);
    expect(state).toMatchObject({ host: "acme.prina.app", email: EMAIL, enabled: true });

    const status = await app.inject({ method: "GET", url: "/api/tunnel/status", headers });
    expect(status.json()).toMatchObject({ configured: true, enabled: true, running: true, host: "acme.prina.app" });
  });

  it("disable stops the process and keeps the record; enable resumes", async () => {
    const off = await app.inject({ method: "POST", url: "/api/tunnel/disable", headers, payload: {} });
    expect(off.statusCode).toBe(200);
    expect((await readTunnelState(db))?.enabled).toBe(false);
    expect(runtime.running()).toBe(false);

    const on = await app.inject({ method: "POST", url: "/api/tunnel/enable", headers, payload: {} });
    expect(on.statusCode).toBe(200);
    expect((await readTunnelState(db))?.enabled).toBe(true);
    expect(runtime.started).toEqual(["cf-connector-token", "cf-connector-token"]);
  });


  it("the remote-admin toggle relays with the ownership token, which never reaches the browser", async () => {
    const before = await app.inject({ method: "GET", url: "/api/tunnel/status", headers });
    expect(before.json()).toMatchObject({ remoteAdmin: false, canToggleRemoteAdmin: true });

    const on = await app.inject({
      method: "POST", url: "/api/tunnel/remote-admin", headers, payload: { enabled: true },
    });
    expect(on.statusCode).toBe(200);
    expect(on.json()).toEqual({ remoteAdmin: true });
    // The ownership token must appear nowhere in the response
    expect(on.body).not.toContain("owner-secret");

    const after = await app.inject({ method: "GET", url: "/api/tunnel/status", headers });
    expect(after.json().remoteAdmin).toBe(true);

    const off = await app.inject({
      method: "POST", url: "/api/tunnel/remote-admin", headers, payload: { enabled: false },
    });
    expect(off.json()).toEqual({ remoteAdmin: false });
  });

  it("the root serves a guidance page — the issue email's 'Open your address' lands here", async () => {
    const res = await app.inject({ method: "GET", url: "/", headers: { host: "acme.prina.app" } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("acme.prina.app/mcp/management");
    // With remote admin off, the page must say the admin is local — claiming it is here would be a lie
    expect(res.body).toContain("localhost");
    expect(res.body).not.toContain("one-time code");
  });

  it("service outage surfaces as 502 TUNNEL_SERVICE_UNREACHABLE (§9 failure modes)", async () => {
    serviceDown = true;
    const res = await app.inject({
      method: "POST", url: "/api/tunnel/code", headers,
      payload: { email: EMAIL, consent: true },
    });
    serviceDown = false;
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe("TUNNEL_SERVICE_UNREACHABLE");
  });
});
