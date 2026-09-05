/**
 * RBAC authorization hook implementation (T2.2) — injected into the T1.4 pipeline's authorize.
 * Rules:
 * - system actor: bypass (bootstrap, internal jobs)
 * - human actor: bypass if instance admin, otherwise judged by workspace role permissions
 * - ai actor: judged via actor.roleIds (MCP token↔role mapping, T6.1) — same rules as humans
 */
import { and, eq, inArray } from "drizzle-orm";
import { ActorType } from "@prina/shared";
import { permissions, userRoles, users } from "../../db/schema/index.js";
import { ForbiddenError } from "../../lib/errors.js";
import type {
  AuthorizeHook,
  CommandCtx,
  PermissionRequest,
} from "../../commands/context.js";
import {
  checkPermission,
  maskValues,
  readableFields,
  type PermissionRow,
} from "./match.js";

export async function actorRoleIds(ctx: CommandCtx): Promise<string[] | "bypass"> {
  const { actor } = ctx;
  if (actor.type === ActorType.System) return "bypass";
  if (actor.type === ActorType.Ai) return actor.roleIds ?? [];
  if (!actor.id) return [];
  const [user] = await ctx.db
    .select({ isInstanceAdmin: users.isInstanceAdmin })
    .from(users)
    .where(eq(users.id, actor.id))
    .limit(1);
  if (user?.isInstanceAdmin) return "bypass";
  const rows = await ctx.db
    .select({ roleId: userRoles.roleId })
    .from(userRoles)
    .where(and(eq(userRoles.userId, actor.id), eq(userRoles.workspaceId, ctx.workspaceId)));
  return rows.map((r) => r.roleId);
}

export async function loadActorPermissions(
  ctx: CommandCtx,
): Promise<PermissionRow[] | "bypass"> {
  const roleIds = await actorRoleIds(ctx);
  if (roleIds === "bypass") return "bypass";
  if (roleIds.length === 0) return [];
  return ctx.db
    .select({
      action: permissions.action,
      subject: permissions.subject,
      fields: permissions.fields,
      locales: permissions.locales,
    })
    .from(permissions)
    .where(
      and(
        eq(permissions.workspaceId, ctx.workspaceId),
        inArray(permissions.roleId, roleIds),
      ),
    );
}

/** Command pipeline authorization hook */
export const rbacAuthorize: AuthorizeHook = async (meta, _input, ctx) => {
  if (!meta.permission) return;
  const perms = await loadActorPermissions(ctx);
  if (perms === "bypass") return;
  const result = checkPermission(perms, meta.permission);
  if (result.allowed) return;
  if (result.deniedFields) {
    throw new ForbiddenError(
      `No permission to write these fields: ${result.deniedFields.join(", ")}`,
    );
  }
  throw new ForbiddenError(
    `Not allowed: ${meta.permission.action} ${meta.permission.subject}`,
  );
};

/** Extra check after the locale is resolved mid-execution (entry.update etc. — locale learned from the DB) */
export async function assertPermissionInExecute(
  ctx: CommandCtx,
  req: PermissionRequest,
): Promise<void> {
  const perms = await loadActorPermissions(ctx);
  if (perms === "bypass") return;
  const result = checkPermission(perms, req);
  if (!result.allowed) {
    throw new ForbiddenError(
      result.deniedFields
        ? `No permission to write these fields: ${result.deniedFields.join(", ")}`
        : `Not allowed: ${req.action} ${req.subject} (locale: ${req.locale ?? "-"})`,
    );
  }
}

/** Response masking (T2.2): strip unreadable fields from the values */
export async function maskReadableValues(
  ctx: CommandCtx,
  subject: string,
  values: Record<string, unknown>,
  locale?: string,
): Promise<Record<string, unknown>> {
  const perms = await loadActorPermissions(ctx);
  if (perms === "bypass") return values;
  return maskValues(values, readableFields(perms, subject, locale));
}

/** Service-level permission query (UI lock indicators, template script gate, etc.) */
export async function canActor(
  ctx: CommandCtx,
  req: PermissionRequest,
): Promise<boolean> {
  const perms = await loadActorPermissions(ctx);
  if (perms === "bypass") return true;
  return checkPermission(perms, req).allowed;
}
