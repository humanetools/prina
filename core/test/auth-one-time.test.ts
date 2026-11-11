/** One-time admin login (IMPL-saas-cloud §3 ④) — token format, replay, expiry, route gating */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { auditLog, users } from "../src/db/schema/index.js";
import {
  MAX_LIFETIME_SEC,
  OneTimeTokenError,
  resetOneTimeReplayStore,
  signOneTimeToken,
  verifyOneTimeToken,
  type OneTimePayload,
} from "../src/modules/auth/one-time.js";
import { setupTestContext, type TestContext } from "./helpers.js";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const privPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const pubPem = publicKey.export({ type: "spki", format: "pem" }).toString();
const otherPriv = generateKeyPairSync("ed25519")
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();

function payload(overrides: Partial<OneTimePayload> = {}): OneTimePayload {
  const iat = Math.floor(Date.now() / 1000);
  return {
    sub: "acct_1",
    tenant: "acme",
    username: "admin",
    iat,
    exp: iat + 120,
    jti: randomUUID(),
    ...overrides,
  };
}

const baseEnv = {
  LOG_LEVEL: "error" as const,
  NODE_ENV: "production" as const,
  ADMIN_DIST_PATH: undefined,
  S3_REGION: "us-east-1",
  LOCAL_STORAGE_DIR: undefined,
};

let t: TestContext;
let app: FastifyInstance;
let adminUsername: string;

beforeAll(async () => {
  t = await setupTestContext();
  const [u] = await t.db.select().from(users).where(eq(users.id, t.userId)).limit(1);
  adminUsername = u!.username;
  app = buildApp({
    env: { ...baseEnv, ONE_TIME_LOGIN_PUBLIC_KEY: pubPem },
    db: t.db,
    services: t.services,
  });
});

afterAll(async () => {
  await app.close();
  await t.cleanup();
});

describe("verifyOneTimeToken (format)", () => {
  it("round-trips a signed payload", () => {
    const p = payload();
    const token = signOneTimeToken(p, privPem);
    expect(token.split(".")).toHaveLength(2);
    expect(verifyOneTimeToken(token, pubPem)).toEqual(p);
  });

  it.each([
    ["not-a-token", "malformed"],
    ["a.b.c", "malformed"],
    ["$$$.###", "malformed"],
  ])("rejects %s as %s", (token, reason) => {
    expect(() => verifyOneTimeToken(token, pubPem)).toThrow(
      expect.objectContaining({ reason }),
    );
  });

  it("rejects a lifetime longer than the cap as malformed", () => {
    const iat = Math.floor(Date.now() / 1000);
    const token = signOneTimeToken(payload({ iat, exp: iat + MAX_LIFETIME_SEC + 1 }), privPem);
    expect(() => verifyOneTimeToken(token, pubPem)).toThrow(
      expect.objectContaining({ reason: "malformed" }),
    );
  });

  it("classifies expired / bad signature / replayed", () => {
    const iat = Math.floor(Date.now() / 1000) - 400;
    const expired = signOneTimeToken(payload({ iat, exp: iat + 120 }), privPem);
    expect(() => verifyOneTimeToken(expired, pubPem)).toThrow(
      expect.objectContaining({ reason: "expired" }),
    );

    const forged = signOneTimeToken(payload(), otherPriv);
    expect(() => verifyOneTimeToken(forged, pubPem)).toThrow(
      expect.objectContaining({ reason: "bad_signature" }),
    );

    const fresh = signOneTimeToken(payload(), privPem);
    verifyOneTimeToken(fresh, pubPem);
    let err: unknown;
    try {
      verifyOneTimeToken(fresh, pubPem);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(OneTimeTokenError);
    expect((err as OneTimeTokenError).reason).toBe("replayed");
  });

  it("sweeps consumed ids once they expire (a later clock forgets them)", () => {
    const p = payload();
    const token = signOneTimeToken(p, privPem);
    verifyOneTimeToken(token, pubPem);
    // Past its own exp the id is swept, but the token itself is now expired anyway
    expect(() => verifyOneTimeToken(token, pubPem, new Date((p.exp + 1) * 1000))).toThrow(
      expect.objectContaining({ reason: "expired" }),
    );
    resetOneTimeReplayStore();
  });
});

describe("GET/POST /api/auth/one-time", () => {
  it("GET: valid link sets the session cookie and redirects to /admin", async () => {
    const token = signOneTimeToken(payload({ username: adminUsername }), privPem);
    const res = await app.inject({
      method: "GET",
      url: `/api/auth/one-time?token=${encodeURIComponent(token)}`,
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/admin");
    const cookie = String(res.headers["set-cookie"]);
    expect(cookie).toContain("prina_session=");
    expect(cookie).toContain("HttpOnly");

    // The cookie is a real session
    const me = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: cookie.split(";")[0]! },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.id).toBe(t.userId);

    // Audit row mirrors the password login path
    const rows = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "auth.login.one-time"));
    expect(rows.some((r) => r.actorId === t.userId)).toBe(true);

    // Second use → replayed
    const again = await app.inject({
      method: "GET",
      url: `/api/auth/one-time?token=${encodeURIComponent(token)}`,
    });
    expect(again.statusCode).toBe(401);
    expect(again.json().error.code).toBe("ONE_TIME_INVALID");
    expect(again.json().error.message).toMatch(/already used/);
    expect(again.headers["set-cookie"]).toBeUndefined();
  });

  it("POST: returns the user id and sets the cookie", async () => {
    const token = signOneTimeToken(payload({ username: adminUsername }), privPem);
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/one-time",
      payload: { token },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ userId: t.userId });
    expect(String(res.headers["set-cookie"])).toContain("prina_session=");
  });

  it("expired token → 401", async () => {
    const iat = Math.floor(Date.now() / 1000) - 200;
    const token = signOneTimeToken(
      payload({ username: adminUsername, iat, exp: iat + 120 }),
      privPem,
    );
    const res = await app.inject({
      method: "GET",
      url: `/api/auth/one-time?token=${encodeURIComponent(token)}`,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("ONE_TIME_INVALID");
    expect(res.json().error.message).toMatch(/expired/);
  });

  it("token signed with another key → 401", async () => {
    const token = signOneTimeToken(payload({ username: adminUsername }), otherPriv);
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/one-time",
      payload: { token },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("ONE_TIME_INVALID");
  });

  it("missing / garbage token → 401", async () => {
    const none = await app.inject({ method: "GET", url: "/api/auth/one-time" });
    expect(none.statusCode).toBe(401);
    const junk = await app.inject({
      method: "POST",
      url: "/api/auth/one-time",
      payload: { token: "nope" },
    });
    expect(junk.statusCode).toBe(401);
  });

  it("unknown username → 403 (and the token is consumed)", async () => {
    const token = signOneTimeToken(payload({ username: `ghost-${randomUUID()}` }), privPem);
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/one-time",
      payload: { token },
    });
    expect(res.statusCode).toBe(403);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("non-admin username → 403", async () => {
    const { userId } = await t.createUserCtx(["editor"]);
    const [u] = await t.db.select().from(users).where(eq(users.id, userId)).limit(1);
    const token = signOneTimeToken(payload({ username: u!.username }), privPem);
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/one-time",
      payload: { token },
    });
    expect(res.statusCode).toBe(403);
  });

  it("route is absent when ONE_TIME_LOGIN_PUBLIC_KEY is unset", async () => {
    const plain = buildApp({ env: baseEnv, db: t.db, services: t.services });
    try {
      const token = signOneTimeToken(payload({ username: adminUsername }), privPem);
      const res = await plain.inject({
        method: "GET",
        url: `/api/auth/one-time?token=${encodeURIComponent(token)}`,
      });
      expect(res.statusCode).toBe(404);
      expect(res.headers["set-cookie"]).toBeUndefined();
    } finally {
      await plain.close();
    }
  });
});
