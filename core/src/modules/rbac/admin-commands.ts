/**
 * Users & Roles management commands (T2.2, backend for Settings T3.5) — the part remaining in core.
 * Custom role creation and permission editing live in EE (src/ee/rbac/commands.ts) — IMPL-ee-boundary §1.
 */
import { z } from "zod";
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { PermissionAction, SystemSubject } from "@prina/shared";
import { permissions, roles, sessions, userRoles, users } from "../../db/schema/index.js";
import { defineCommand } from "../../commands/define.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../../lib/errors.js";
import { hashPassword } from "../auth/passwords.js";
import { usernameSchema } from "../auth/username.js";

export const roleList = defineCommand({
  name: "role.list",
  resource: "role",
  skipAudit: true,
  input: z.object({}).default({}),
  permission: () => ({ action: PermissionAction.Read, subject: SystemSubject.UsersRoles }),
  async execute(_input, ctx) {
    const roleRows = await ctx.db
      .select()
      .from(roles)
      .where(eq(roles.workspaceId, ctx.workspaceId))
      .orderBy(asc(roles.name));
    const permRows = await ctx.db
      .select()
      .from(permissions)
      .where(eq(permissions.workspaceId, ctx.workspaceId));
    return roleRows.map((r) => ({
      ...r,
      permissions: permRows.filter((p) => p.roleId === r.id),
    }));
  },
});

export const userCreate = defineCommand({
  name: "user.create",
  resource: "user",
  input: z.object({
    username: usernameSchema,
    password: z.string().min(8).max(200),
    name: z.string().min(1).max(200),
    roleIds: z.array(z.string().uuid()).default([]),
  }),
  permission: () => ({ action: PermissionAction.Create, subject: SystemSubject.UsersRoles }),
  async execute(input, ctx) {
    const [existing] = await ctx.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, input.username))
      .limit(1);
    if (existing) throw new ConflictError("That username is already taken");
    if (input.roleIds.length > 0) {
      const found = await ctx.db
        .select({ id: roles.id })
        .from(roles)
        .where(and(eq(roles.workspaceId, ctx.workspaceId), inArray(roles.id, input.roleIds)));
      if (found.length !== input.roleIds.length) {
        throw new ValidationError("Includes a role that is not in this workspace");
      }
    }
    const [user] = await ctx.db
      .insert(users)
      .values({
        username: input.username,
        name: input.name,
        passwordHash: await hashPassword(input.password),
        mustChangePassword: true,
      })
      .returning();
    if (input.roleIds.length > 0) {
      await ctx.db.insert(userRoles).values(
        input.roleIds.map((roleId) => ({
          userId: user!.id,
          roleId,
          workspaceId: ctx.workspaceId,
        })),
      );
    }
    const { passwordHash: _ph, ...safe } = user!;
    return safe;
  },
  resourceId: (_i, o) => o.id,
  auditPayload: (i) => ({ username: i.username, roleCount: i.roleIds.length }),
});

export const userList = defineCommand({
  name: "user.list",
  resource: "user",
  skipAudit: true,
  input: z.object({}).default({}),
  permission: () => ({ action: PermissionAction.Read, subject: SystemSubject.UsersRoles }),
  async execute(_input, ctx) {
    const assignments = await ctx.db
      .select({ userId: userRoles.userId, roleId: userRoles.roleId })
      .from(userRoles)
      .where(eq(userRoles.workspaceId, ctx.workspaceId));
    const userIds = [...new Set(assignments.map((a) => a.userId))];
    const rows = userIds.length
      ? await ctx.db.select().from(users).where(inArray(users.id, userIds))
      : [];
    const admins = await ctx.db.select().from(users).where(eq(users.isInstanceAdmin, true));
    const all = [...rows, ...admins.filter((a) => !userIds.includes(a.id))];
    return all.map(({ passwordHash: _ph, ...u }) => ({
      ...u,
      roleIds: assignments.filter((a) => a.userId === u.id).map((a) => a.roleId),
    }));
  },
});

/**
 * Edit another person's account (2026-11-05) — name, username, password reset, roles, active flag.
 * Who: holders of users_roles:update (the admin role) and the instance creator (bypasses RBAC).
 * Guards: only the instance creator may edit the instance creator's account; nobody can deactivate
 * themselves; the instance-creator flag itself is never editable. A password reset or deactivation
 * signs that user out everywhere (sessions dropped).
 */
export const userUpdate = defineCommand({
  name: "user.update",
  resource: "user",
  input: z.object({
    id: z.string().uuid(),
    name: z.string().min(1).max(200).optional(),
    username: usernameSchema.optional(),
    /** new password — set by the admin, no current password needed */
    password: z.string().min(8).max(200).optional(),
    /** replaces the user's roles in this workspace */
    roleIds: z.array(z.string().uuid()).optional(),
    isActive: z.boolean().optional(),
  }),
  permission: () => ({ action: PermissionAction.Update, subject: SystemSubject.UsersRoles }),
  async execute(input, ctx) {
    const [target] = await ctx.db.select().from(users).where(eq(users.id, input.id)).limit(1);
    if (!target) throw new NotFoundError("User not found");
    const actorId = ctx.actor.id;
    const [actor] = actorId ? await ctx.db.select({ isInstanceAdmin: users.isInstanceAdmin }).from(users).where(eq(users.id, actorId)).limit(1) : [];
    if (target.isInstanceAdmin && !actor?.isInstanceAdmin) {
      throw new ForbiddenError("Only the instance creator can edit the instance creator's account");
    }
    if (input.isActive === false && target.id === actorId) {
      throw new ValidationError("You cannot deactivate your own account");
    }
    if (input.username && input.username !== target.username) {
      const [taken] = await ctx.db.select({ id: users.id }).from(users)
        .where(and(eq(users.username, input.username), ne(users.id, target.id))).limit(1);
      if (taken) throw new ConflictError("That username is already taken");
    }
    if (input.roleIds) {
      const unique = [...new Set(input.roleIds)];
      if (unique.length > 0) {
        const found = await ctx.db.select({ id: roles.id }).from(roles)
          .where(and(eq(roles.workspaceId, ctx.workspaceId), inArray(roles.id, unique)));
        if (found.length !== unique.length) throw new ValidationError("Includes a role that is not in this workspace");
      }
      await ctx.db.delete(userRoles).where(and(eq(userRoles.userId, target.id), eq(userRoles.workspaceId, ctx.workspaceId)));
      if (unique.length > 0) {
        await ctx.db.insert(userRoles).values(unique.map((roleId) => ({ userId: target.id, roleId, workspaceId: ctx.workspaceId })));
      }
    }
    const patch: Partial<typeof users.$inferInsert> = { updatedAt: new Date() };
    if (input.name !== undefined) patch.name = input.name;
    if (input.username !== undefined) patch.username = input.username;
    if (input.password !== undefined) {
      patch.passwordHash = await hashPassword(input.password);
      // an admin-set password is temporary — the user picks their own at next sign-in
      patch.mustChangePassword = true;
    }
    if (input.isActive !== undefined) patch.isActive = input.isActive;
    const [row] = await ctx.db.update(users).set(patch).where(eq(users.id, target.id)).returning();
    if (input.password !== undefined || input.isActive === false) {
      await ctx.db.delete(sessions).where(eq(sessions.userId, target.id));
    }
    const assigned = await ctx.db.select({ roleId: userRoles.roleId }).from(userRoles)
      .where(and(eq(userRoles.userId, target.id), eq(userRoles.workspaceId, ctx.workspaceId)));
    const { passwordHash: _ph, ...safe } = row!;
    return { ...safe, roleIds: assigned.map((a) => a.roleId) };
  },
  resourceId: (i) => i.id,
  auditPayload: (i) => ({
    fields: Object.keys(i).filter((k) => k !== "id" && k !== "password"),
    passwordReset: i.password !== undefined,
  }),
});
