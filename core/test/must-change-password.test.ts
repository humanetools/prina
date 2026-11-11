/** Admin-created accounts and admin-reset passwords force a password change at first sign-in (2026-11-09) — HTTP E2E */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { createDb, type Db } from "../src/db/client.js";
import { users } from "../src/db/schema/index.js";
import { userCreate, userUpdate } from "../src/modules/rbac/admin-commands.js";
import { setupTestContext, type TestContext } from "./helpers.js";

let t: TestContext;
let app: FastifyInstance;
let db: Db;
const USERNAME = `mcp-${Date.now()}`;
let userId = "";

beforeAll(async () => {
  t = await setupTestContext();
  ({ db } = createDb(process.env.TEST_DATABASE_URL!));
  app = buildApp({
    env: { LOG_LEVEL: "error", NODE_ENV: "production", ADMIN_DIST_PATH: undefined, S3_REGION: "us-east-1" },
    db,
    services: t.services,
  });
  const u = await userCreate.run({ username: USERNAME, password: "temporary-1", name: "New", roleIds: [t.roleId("editor")] }, t.ctx);
  userId = u.id;
});
afterAll(async () => {
  await app.close();
  await t.cleanup();
});

const login = async (password: string) =>
  (await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: USERNAME, password } })).json();
const h = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

describe("must change password", () => {
  it("a new account signs in flagged; other APIs answer 403 PASSWORD_CHANGE_REQUIRED until it changes", async () => {
    const { token, user } = await login("temporary-1");
    expect(user.mustChangePassword).toBe(true);
    const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: h(token) });
    expect(me.json().user.mustChangePassword).toBe(true);
    const blocked = await app.inject({ method: "GET", url: "/api/content-types?x=1", headers: h(token) });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe("PASSWORD_CHANGE_REQUIRED");

    const changed = await app.inject({
      method: "POST", url: "/api/auth/password", headers: h(token),
      payload: { currentPassword: "temporary-1", newPassword: "my-own-password-1" },
    });
    expect(changed.statusCode).toBe(200);
    const fresh = changed.json().token as string;
    expect((await app.inject({ method: "GET", url: "/api/auth/me", headers: h(fresh) })).json().user.mustChangePassword).toBe(false);
    const after = await app.inject({ method: "GET", url: "/api/content-types", headers: h(fresh) });
    expect(after.json().error?.code).not.toBe("PASSWORD_CHANGE_REQUIRED");
  });

  it("an admin password reset flags it again; a name-only edit does not", async () => {
    await userUpdate.run({ id: userId, name: "Renamed" }, t.ctx);
    expect((await db.select().from(users).where(eq(users.id, userId)))[0]!.mustChangePassword).toBe(false);
    await userUpdate.run({ id: userId, password: "reset-by-admin-1" }, t.ctx);
    expect((await db.select().from(users).where(eq(users.id, userId)))[0]!.mustChangePassword).toBe(true);
    const { user } = await login("reset-by-admin-1");
    expect(user.mustChangePassword).toBe(true);
  });
});
