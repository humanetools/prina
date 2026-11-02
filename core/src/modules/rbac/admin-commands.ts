/**
 * Users & Roles management commands (T2.2, backend for Settings T3.5) — the part remaining in core.
 * Custom role creation and permission editing live in EE (src/ee/rbac/commands.ts) — IMPL-ee-boundary §1.
 */
import { z } from "zod";
import { and, asc, eq, inArray } from "drizzle-orm";
import { PermissionAction, SystemSubject } from "@prina/shared";
import { permissions, roles, userRoles, users } from "../../db/schema/index.js";
import { defineCommand } from "../../commands/define.js";
import { ConflictError, ValidationError } from "../../lib/errors.js";
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
