/** user.update (2026-11-05): admins and the instance creator edit other people's accounts */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { sessions, users } from "../src/db/schema/index.js";
import { userCreate, userUpdate } from "../src/modules/rbac/admin-commands.js";
import { verifyPassword } from "../src/modules/auth/passwords.js";
import { setupTestContext, type TestContext } from "./helpers.js";

let t: TestContext;
let targetId = "";
let instanceAdminId = "";

beforeAll(async () => {
  t = await setupTestContext();
  const u = await userCreate.run({ username: `uu-${Date.now()}`, password: "password-1", name: "Target", roleIds: [t.roleId("editor")] }, t.ctx);
  targetId = u.id;
  const [ia] = await t.db.insert(users).values({ username: `owner-${Date.now()}`, name: "Owner", isInstanceAdmin: true }).returning();
  instanceAdminId = ia!.id;
});
afterAll(async () => { await t.cleanup(); });

describe("user.update", () => {
  it("an admin changes name, username, roles and resets the password (sessions dropped)", async () => {
    const { ctx } = await t.createUserCtx(["admin"]);
    await t.db.insert(sessions).values({ userId: targetId, tokenHash: `h-${Date.now()}`, expiresAt: new Date(Date.now() + 3_600_000) });
    const out = await userUpdate.run(
      { id: targetId, name: "Renamed", username: `renamed-${Date.now()}`, roleIds: [t.roleId("developer"), t.roleId("publisher")], password: "new-password-2" },
      ctx,
    );
    expect(out.name).toBe("Renamed");
    expect(out.roleIds.sort()).toEqual([t.roleId("developer"), t.roleId("publisher")].sort());
    expect("passwordHash" in out).toBe(false);
    const [row] = await t.db.select().from(users).where(eq(users.id, targetId));
    expect(await verifyPassword("new-password-2", row!.passwordHash!)).toBe(true);
    expect(await t.db.select().from(sessions).where(eq(sessions.userId, targetId))).toHaveLength(0);
  });

  it("deactivates and reactivates another user, but not oneself", async () => {
    const { ctx, userId } = await t.createUserCtx(["admin"]);
    expect((await userUpdate.run({ id: targetId, isActive: false }, ctx)).isActive).toBe(false);
    expect((await userUpdate.run({ id: targetId, isActive: true }, ctx)).isActive).toBe(true);
    await expect(userUpdate.run({ id: userId, isActive: false }, ctx)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("non-admin roles are refused", async () => {
    const { ctx } = await t.createUserCtx(["developer", "editor", "publisher"]);
    await expect(userUpdate.run({ id: targetId, name: "x" }, ctx)).rejects.toMatchObject({ statusCode: 403 });
  });

  it("only the instance creator may edit the instance creator's account", async () => {
    const { ctx } = await t.createUserCtx(["admin"]);
    await expect(userUpdate.run({ id: instanceAdminId, name: "Hijack" }, ctx)).rejects.toMatchObject({ statusCode: 403 });
    const ownerCtx = { ...t.ctx, actor: { ...t.ctx.actor, id: instanceAdminId } };
    expect((await userUpdate.run({ id: instanceAdminId, name: "Owner 2" }, ownerCtx)).name).toBe("Owner 2");
    expect((await userUpdate.run({ id: targetId, name: "By owner" }, ownerCtx)).name).toBe("By owner");
  });

  it("rejects a taken username, unknown roles, an unknown user", async () => {
    const other = await userCreate.run({ username: `taken-${Date.now()}`, password: "password-1", name: "Other" }, t.ctx);
    await expect(userUpdate.run({ id: targetId, username: other.username }, t.ctx)).rejects.toMatchObject({ statusCode: 409 });
    await expect(userUpdate.run({ id: targetId, roleIds: ["00000000-0000-0000-0000-000000000000"] }, t.ctx)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(userUpdate.run({ id: "00000000-0000-0000-0000-000000000000", name: "x" }, t.ctx)).rejects.toMatchObject({ statusCode: 404 });
  });
});
