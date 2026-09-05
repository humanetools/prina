/** My account — profile edit and password change (HTTP E2E) */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { createDb, type Db } from "../src/db/client.js";
import { users } from "../src/db/schema/index.js";
import { hashPassword } from "../src/modules/auth/passwords.js";
import { setupTestContext, type TestContext } from "./helpers.js";

let t: TestContext;
let app: FastifyInstance;
let db: Db;
let token: string;
const USERNAME = "profile-test";
const PW = "initial-password-1";

beforeAll(async () => {
  t = await setupTestContext();
  ({ db } = createDb(process.env.TEST_DATABASE_URL!));
  app = buildApp({
    env: { LOG_LEVEL: "error", NODE_ENV: "production", ADMIN_DIST_PATH: undefined, S3_REGION: "us-east-1" },
    db,
    services: t.services,
  });
  // Prepare a user who can log in (instance admin — no workspace membership needed)
  await db.insert(users).values({
    username: USERNAME,
    name: "Before",
    passwordHash: await hashPassword(PW),
    isInstanceAdmin: true,
  });
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username: USERNAME, password: PW },
  });
  token = login.json().token;
});
afterAll(async () => {
  await app.close();
  await t.cleanup();
});

const auth = () => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

describe("my account (profile)", () => {
  it("profile read does not expose the password hash", async () => {
    const res = await app.inject({ method: "GET", url: "/api/auth/profile", headers: auth() });
    expect(res.statusCode).toBe(200);
    expect(res.json().username).toBe(USERNAME);
    expect(res.json().passwordHash).toBeUndefined();
  });

  it("updates name and username", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/auth/profile",
      headers: auth(),
      payload: { name: "After", username: "changed-id" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: "After", username: "changed-id" });
  });

  it("cannot change to a username used by another user", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/auth/profile",
      headers: auth(),
      payload: { username: "tester-dup" },
    });
    expect(res.statusCode).toBe(200); // unused username passes
    await db.insert(users).values({
      username: "taken-id",
      name: "Other",
      passwordHash: await hashPassword("x".repeat(12)),
    });
    const dup = await app.inject({
      method: "PUT",
      url: "/api/auth/profile",
      headers: auth(),
      payload: { username: "taken-id" },
    });
    expect(dup.statusCode).toBe(409);
  });

  it("rejects the change when the current password is wrong", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/password",
      headers: auth(),
      payload: { currentPassword: "wrong-password", newPassword: "brand-new-password-1" },
    });
    expect(res.statusCode).toBe(422);
  });

  it("after a password change the new password logs in and the old one is blocked", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/password",
      headers: auth(),
      payload: { currentPassword: PW, newPassword: "brand-new-password-1" },
    });
    expect(res.statusCode).toBe(200);
    // the current device session is re-issued and kept
    const newToken = res.json().token as string;
    expect(newToken).toBeTruthy();

    const [me] = await db
      .select({ username: users.username })
      .from(users)
      .where(eq(users.username, "taken-id"));
    expect(me).toBeUndefined; // (the duplicate-username change failed, so mine is unchanged)

    const meRes = await app.inject({
      method: "GET",
      url: "/api/auth/profile",
      headers: { authorization: `Bearer ${newToken}` },
    });
    expect(meRes.statusCode).toBe(200);
    const myId = meRes.json().username as string;

    const oldLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: myId, password: PW },
    });
    expect(oldLogin.statusCode).toBe(401);

    const newLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: myId, password: "brand-new-password-1" },
    });
    expect(newLogin.statusCode).toBe(200);
    token = newLogin.json().token;
  });

  it("cannot be accessed while logged out", async () => {
    const res = await app.inject({ method: "GET", url: "/api/auth/profile" });
    expect(res.statusCode).toBe(401);
  });
});
