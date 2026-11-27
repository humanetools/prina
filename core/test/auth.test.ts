/** Setup wizard 5 steps + session auth flow (T2.1) — HTTP E2E */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { createDb, type Db } from "../src/db/client.js";
import { instanceSettings, users } from "../src/db/schema/index.js";
import { bootstrap } from "../src/bootstrap.js";
import { invalidateSetupCache } from "../src/http/auth-hooks.js";

let app: FastifyInstance;
let db: Db;
let pool: { end(): Promise<void> };
let adminToken: string;

beforeAll(async () => {
  ({ db, pool } = createDb(process.env.TEST_DATABASE_URL!));
  await bootstrap(db);
  // Reset to setup-incomplete state (remove the completed flag other test files may have planted)
  await db.delete(instanceSettings).where(eq(instanceSettings.key, "setup"));
  await db.update(users).set({ isInstanceAdmin: false });
  invalidateSetupCache();
  app = buildApp({
    env: {
      LOG_LEVEL: "error",
      NODE_ENV: "production", // Verify gate/auth under production rules (blocks the dev header fallback)
      ADMIN_DIST_PATH: undefined,
      S3_REGION: "us-east-1",
      LOCAL_STORAGE_DIR: undefined,
    },
    db,
  });
});
afterAll(async () => {
  // Restore the completed state for subsequent test files
  await db
    .insert(instanceSettings)
    .values({
      key: "setup",
      value: {
        adminCreated: true,
        workspaceConfigured: true,
        localesConfigured: true,
        completed: true,
      },
    })
    .onConflictDoNothing();
  invalidateSetupCache();
  await app.close();
  await pool.end();
});

describe("setup wizard (T2.1, §3.4)", () => {
  it("blocks regular APIs at the gate while setup is incomplete", async () => {
    const res = await app.inject({ method: "GET", url: "/api/content-types" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("SETUP_REQUIRED");
  });

  it("rejects a complete attempt with the list of unfinished steps", async () => {
    const res = await app.inject({ method: "POST", url: "/api/setup/complete" });
    expect(res.statusCode).toBe(422);
  });

  it("walks through 5 steps in order → complete", async () => {
    const admin = await app.inject({
      method: "POST",
      url: "/api/setup/admin",
      payload: { username: "admin", password: "super-secret-1", name: "관리자" },
    });
    expect(admin.statusCode).toBe(200);
    adminToken = admin.json().token;
    expect(adminToken).toBeTruthy();

    // Blocks creating a duplicate admin
    const dup = await app.inject({
      method: "POST",
      url: "/api/setup/admin",
      payload: { username: "second", password: "super-secret-1", name: "2번" },
    });
    expect(dup.statusCode).toBe(409);

    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/setup/workspace",
          payload: { name: "HIKROBOT 콘텐츠 허브" },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/setup/locales",
          payload: {
            locales: [
              { code: "ko", name: "한국어", isDefault: true },
              { code: "en", name: "English" },
            ],
          },
        })
      ).statusCode,
    ).toBe(200);
    const complete = await app.inject({ method: "POST", url: "/api/setup/complete" });
    expect(complete.statusCode).toBe(200);
    expect(complete.json().completed).toBe(true);
  });
});

describe("session auth (T2.1)", () => {
  it("after setup, unauthenticated API returns 401, session token passes", async () => {
    const anon = await app.inject({ method: "GET", url: "/api/content-types" });
    expect(anon.statusCode).toBe(401);

    const authed = await app.inject({
      method: "GET",
      url: "/api/content-types",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(authed.statusCode).toBe(200);
  });

  it("login → me → logout cycle", async () => {
    const bad = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: "wrong-password" },
    });
    expect(bad.statusCode).toBe(401);

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: "super-secret-1" },
    });
    expect(login.statusCode).toBe(200);
    const token = login.json().token as string;
    expect(login.headers["set-cookie"]).toContain("prina_session=");
    // Plain HTTP (on-prem kit at http://localhost) must not mark the cookie Secure
    expect(login.headers["set-cookie"]).not.toContain("Secure");

    const me = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.username).toBe("admin");

    const logout = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(logout.statusCode).toBe(200);

    const afterLogout = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(afterLogout.statusCode).toBe(401);
  });
});

describe("session cookie Secure flag (hosted/proxied deployments)", () => {
  const login = (target: FastifyInstance, headers: Record<string, string> = {}) =>
    target.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: "super-secret-1" },
      headers,
    });

  it("ignores x-forwarded-proto when the proxy is not trusted (default)", async () => {
    const res = await login(app, { "x-forwarded-proto": "https" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["set-cookie"]).not.toContain("Secure");
  });

  it("marks the cookie Secure when a trusted proxy reports https", async () => {
    const proxied = buildApp({
      env: {
        LOG_LEVEL: "error",
        NODE_ENV: "production",
        TRUST_PROXY: "true",
        ADMIN_DIST_PATH: undefined,
        S3_REGION: "us-east-1",
        LOCAL_STORAGE_DIR: undefined,
      },
      db,
    });
    try {
      const secure = await login(proxied, { "x-forwarded-proto": "https" });
      expect(secure.statusCode).toBe(200);
      expect(secure.headers["set-cookie"]).toContain("; Secure");

      const logout = await proxied.inject({
        method: "POST",
        url: "/api/auth/logout",
        headers: { authorization: `Bearer ${secure.json().token}`, "x-forwarded-proto": "https" },
      });
      expect(logout.headers["set-cookie"]).toContain("Max-Age=0; Secure");

      // Same trusted proxy, but the upstream hop was plain http → no Secure
      const plain = await login(proxied, { "x-forwarded-proto": "http" });
      expect(plain.statusCode).toBe(200);
      expect(plain.headers["set-cookie"]).not.toContain("Secure");
    } finally {
      await proxied.close();
    }
  });
});

describe("login brute-force defense", () => {
  it("repeated failures lock to 429, and the lock beats a correct password", async () => {
    // Once a public address is provisioned this endpoint faces the internet (the OAuth screen POSTs here)
    let last = 0;
    for (let i = 0; i < 9; i += 1) {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "admin", password: "wrong-guess-" + i },
      });
      last = res.statusCode;
    }
    expect(last).toBe(429);

    const locked = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: "super-secret-1" },
    });
    expect(locked.statusCode).toBe(429);
    expect(locked.headers["retry-after"]).toBeTruthy();
  });
});
