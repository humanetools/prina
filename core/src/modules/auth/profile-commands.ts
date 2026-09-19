/**
 * My-account commands — own profile and password changes.
 * [design] No permission hook. The target is fixed to "the actor themself", so role is
 * irrelevant; password change proves identity by re-checking the current password
 * (proof of ownership, not permission).
 */
import { z } from "zod";
import { and, eq, ne } from "drizzle-orm";
import { ActorType } from "@prina/shared";
import { sessions, users } from "../../db/schema/index.js";
import { defineCommand } from "../../commands/define.js";
import { ConflictError, ForbiddenError, ValidationError } from "../../lib/errors.js";
import type { CommandCtx } from "../../commands/context.js";
import { hashPassword, verifyPassword } from "./passwords.js";
import { usernameSchema } from "./username.js";

/** Only human actors may edit their own account (MCP tokens/system actors cannot) */
async function requireSelf(ctx: CommandCtx) {
  if (ctx.actor.type !== ActorType.Human || !ctx.actor.id) {
    throw new ForbiddenError("Only a signed-in user can change their own account");
  }
  const [me] = await ctx.db.select().from(users).where(eq(users.id, ctx.actor.id)).limit(1);
  if (!me) throw new ForbiddenError("User not found");
  return me;
}

export const profileGet = defineCommand({
  name: "profile.get",
  resource: "user",
  skipAudit: true,
  input: z.object({}).default({}),
  async execute(_input, ctx) {
    const me = await requireSelf(ctx);
    const { passwordHash: _ph, ...safe } = me;
    return safe;
  },
});

export const profileUpdate = defineCommand({
  name: "profile.update",
  resource: "user",
  input: z.object({
    name: z.string().min(1).max(200).optional(),
    username: usernameSchema.optional(),
  }),
  async execute(input, ctx) {
    const me = await requireSelf(ctx);
    if (input.username && input.username !== me.username) {
      const [dup] = await ctx.db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.username, input.username), ne(users.id, me.id)))
        .limit(1);
      if (dup) throw new ConflictError("That username is already taken");
    }
    const [row] = await ctx.db
      .update(users)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.username !== undefined ? { username: input.username } : {}),
        updatedAt: new Date(),
      })
      .where(eq(users.id, me.id))
      .returning();
    const { passwordHash: _ph, ...safe } = row!;
    return safe;
  },
  resourceId: (_i, o) => o.id,
  auditPayload: (i) => ({
    nameChanged: i.name !== undefined,
    usernameChanged: i.username !== undefined,
  }),
});

export const passwordChange = defineCommand({
  name: "profile.change_password",
  resource: "user",
  input: z.object({
    currentPassword: z.string().min(1),
    newPassword: z.string().min(8).max(200),
  }),
  async execute(input, ctx) {
    const me = await requireSelf(ctx);
    const ok = me.passwordHash
      ? await verifyPassword(input.currentPassword, me.passwordHash)
      : false;
    if (!ok) throw new ValidationError("Current password is incorrect");
    if (input.currentPassword === input.newPassword) {
      throw new ValidationError("New password matches the current one");
    }
    await ctx.db
      .update(users)
      .set({ passwordHash: await hashPassword(input.newPassword), updatedAt: new Date() })
      .where(eq(users.id, me.id));
    // On password change, drop all sessions on other devices (standard anti-hijack behavior).
    // The HTTP adapter reissues the current session so the user stays logged in.
    await ctx.db.delete(sessions).where(eq(sessions.userId, me.id));
    return { id: me.id };
  },
  resourceId: (_i, o) => o.id,
});
