/** MCP token commands (T6.1/T6.4) — issue, revoke, verify. Token↔role mapping */
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { and, desc, eq, isNull } from "drizzle-orm";
import {
  API_GRANT_EDIT_ONLY,
  API_GRANT_TYPED,
  ActorType,
  ApiGrantItem,
  ApiGrantLevel,
  ApiScope,
  ApiScopeLevel,
  LEGACY_API_SCOPES,
  McpPlane,
  PermissionAction,
  SystemSubject,
  type ApiGrant,
  type ApiScopes,
} from "@prina/shared";
import { actionsOf, subjectsOf } from "../../http/api-grants.js";
import { loadActorPermissions } from "../rbac/service.js";
import { checkPermission } from "../rbac/match.js";
import { mcpTokens, roles } from "../../db/schema/index.js";
import { defineCommand } from "../../commands/define.js";
import { ConflictError, NotFoundError, ValidationError } from "../../lib/errors.js";
import type { Db } from "../../db/client.js";

const mcpPermission = (action: string) => () => ({
  action,
  subject: SystemSubject.McpConsole,
});

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

const grantSchema = z
  .object({
    item: z.nativeEnum(ApiGrantItem),
    level: z.nativeEnum(ApiGrantLevel),
    types: z.array(z.string().regex(/^[a-z0-9_]+$/)).min(1).max(100).optional(),
  })
  .superRefine((g, c) => {
    if (API_GRANT_EDIT_ONLY.includes(g.item) && g.level !== ApiGrantLevel.Edit) {
      c.addIssue({ code: "custom", message: `${g.item} is edit-only` });
    }
    if (g.types && !API_GRANT_TYPED.includes(g.item)) {
      c.addIssue({ code: "custom", message: `${g.item} cannot be narrowed by content type` });
    }
  });

export const mcpTokenCreate = defineCommand({
  name: "mcp_token.create",
  resource: "mcp_token",
  input: z.object({
    plane: z.nativeEnum(McpPlane),
    /** AI identifier (audit log mcp:<name>) */
    name: z.string().regex(/^[a-z0-9][a-z0-9_-]{1,63}$/),
    /** required for management: executes with this role's permissions */
    roleId: z.string().uuid().optional(),
    /** delivery: locale scope (optional) */
    localeScope: z.string().optional(),
    /** management, role mode: REST surface per resource group (20-IMPL). Omitted = { content: edit }; {} = MCP only (no REST) */
    scopes: z.record(z.nativeEnum(ApiScope), z.nativeEnum(ApiScopeLevel)).optional(),
    /**
     * management, custom mode: explicit grants — area ▸ item ▸ level (+types). Non-empty = the token's
     * rights are exactly these grants and no role is needed; the issuer's own permissions are the ceiling.
     */
    grants: z.array(grantSchema).max(50).optional(),
  }),
  permission: mcpPermission(PermissionAction.Create),
  async execute(input, ctx) {
    if (input.plane === McpPlane.Management) {
      const grants = input.grants ?? [];
      if (grants.length > 0 && input.scopes) {
        throw new ValidationError("Choose one mode: a role with API scopes, or explicit grants");
      }
      if (grants.length === 0 && !input.roleId) {
        throw new ValidationError("A management token needs a role binding (or explicit grants)");
      }
      if (input.roleId) {
        const [role] = await ctx.db
          .select({ id: roles.id })
          .from(roles)
          .where(and(eq(roles.workspaceId, ctx.workspaceId), eq(roles.id, input.roleId)))
          .limit(1);
        if (!role) throw new ValidationError("That role is not in this workspace");
      }
      if (grants.length > 0) await assertIssuerCeiling(ctx, grants);
    } else if (input.scopes || input.grants) {
      throw new ValidationError("Scopes and grants apply to management tokens only");
    }
    // The unique index covers revoked rows too (names stay attached to their audit trail), so a
    // reused name must be refused here with a clear message instead of surfacing as a 500.
    const [dup] = await ctx.db
      .select({ id: mcpTokens.id, revokedAt: mcpTokens.revokedAt })
      .from(mcpTokens)
      .where(and(eq(mcpTokens.workspaceId, ctx.workspaceId), eq(mcpTokens.name, input.name)))
      .limit(1);
    if (dup) {
      throw new ConflictError(
        dup.revokedAt
          ? `A token named '${input.name}' was issued before and is revoked — names are permanent, pick a new one`
          : `An active token named '${input.name}' already exists`,
      );
    }

    const raw = `pmt_${input.plane === McpPlane.Management ? "mgmt" : "dlv"}_${randomBytes(24).toString("base64url")}`;
    const [row] = await ctx.db
      .insert(mcpTokens)
      .values({
        workspaceId: ctx.workspaceId,
        plane: input.plane,
        name: input.name,
        tokenHash: hashToken(raw),
        roleId: input.roleId ?? null,
        localeScope: input.localeScope ?? null,
        // role mode keeps scopes (default = what tokens always had); custom mode stores grants and no scopes
        scopes: input.plane === McpPlane.Management && !(input.grants && input.grants.length > 0) ? (input.scopes ?? LEGACY_API_SCOPES) : null,
        grants: input.plane === McpPlane.Management && input.grants && input.grants.length > 0 ? input.grants : null,
        createdBy: ctx.actor.type === "human" ? (ctx.actor.id ?? null) : null,
      })
      .returning();
    // the raw token is exposed only once, in this response
    return { token: raw, record: { ...row!, tokenHash: undefined } };
  },
  resourceId: (_i, o) => o.record.id,
  auditPayload: (i) => ({ plane: i.plane, name: i.name, scopes: i.scopes ?? null, grants: i.grants ?? null }),
});

export const mcpTokenList = defineCommand({
  name: "mcp_token.list",
  resource: "mcp_token",
  skipAudit: true,
  input: z.object({}).default({}),
  permission: mcpPermission(PermissionAction.Read),
  async execute(_input, ctx) {
    const rows = await ctx.db
      .select({
        id: mcpTokens.id,
        plane: mcpTokens.plane,
        name: mcpTokens.name,
        roleId: mcpTokens.roleId,
        localeScope: mcpTokens.localeScope,
        scopes: mcpTokens.scopes,
        grants: mcpTokens.grants,
        lastUsedAt: mcpTokens.lastUsedAt,
        revokedAt: mcpTokens.revokedAt,
        createdAt: mcpTokens.createdAt,
      })
      .from(mcpTokens)
      .where(eq(mcpTokens.workspaceId, ctx.workspaceId))
      .orderBy(desc(mcpTokens.createdAt));
    return rows.map((r) => ({
      ...r,
      grants: (r.grants as ApiGrant[] | null) ?? null,
      // custom-mode tokens have no scopes at all; role-mode tokens resolve legacy NULL
      scopes: r.plane === McpPlane.Management && !(r.grants && r.grants.length > 0) ? effectiveScopes(r.scopes) : null,
    }));
  },
});

/**
 * A custom-grant token can never carry more than its issuer: every action×subject the grants
 * confer must be allowed for the issuing user (instance admins bypass). "You can't grant what
 * you don't have", checked at issue time.
 */
async function assertIssuerCeiling(ctx: Parameters<typeof loadActorPermissions>[0], grants: ApiGrant[]): Promise<void> {
  if (ctx.actor.type !== ActorType.Human) {
    throw new ValidationError("Access tokens with explicit grants are issued by a signed-in user");
  }
  const mine = await loadActorPermissions(ctx);
  if (mine === "bypass") return;
  const denied: string[] = [];
  for (const g of grants) {
    for (const subject of subjectsOf(g)) {
      for (const action of actionsOf(g)) {
        if (!checkPermission(mine, { action, subject }).allowed) denied.push(`${action} ${subject}`);
      }
    }
  }
  if (denied.length > 0) {
    throw new ValidationError("You cannot grant more than you have", { denied: [...new Set(denied)] });
  }
}

/** NULL (issued before 20-IMPL) reads as the original surface: content at edit level */
export function effectiveScopes(stored: Record<string, string> | null | undefined): ApiScopes {
  return (stored ?? LEGACY_API_SCOPES) as ApiScopes;
}

export const mcpTokenRevoke = defineCommand({
  name: "mcp_token.revoke",
  resource: "mcp_token",
  input: z.object({ id: z.string().uuid() }),
  permission: mcpPermission(PermissionAction.Delete),
  async execute(input, ctx) {
    const [row] = await ctx.db
      .update(mcpTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(mcpTokens.workspaceId, ctx.workspaceId), eq(mcpTokens.id, input.id)))
      .returning();
    if (!row) throw new NotFoundError("Token not found");
    return { id: row.id, name: row.name };
  },
  resourceId: (i) => i.id,
  auditPayload: (_i, o) => ({ name: o.name }),
});

export interface VerifiedMcpToken {
  id: string;
  workspaceId: string;
  plane: string;
  name: string;
  roleId: string | null;
  localeScope: string | null;
  /** management, role mode: effective REST scopes (legacy NULL already resolved) */
  scopes: ApiScopes;
  /** management, custom mode: explicit grants (non-empty) — null for role-mode tokens */
  grants: ApiGrant[] | null;
}

/** Bearer token verification — used by the MCP HTTP adapter */
export async function verifyMcpToken(
  db: Db,
  rawToken: string,
  plane: McpPlane,
): Promise<VerifiedMcpToken | null> {
  const [row] = await db
    .select()
    .from(mcpTokens)
    .where(
      and(
        eq(mcpTokens.tokenHash, hashToken(rawToken)),
        eq(mcpTokens.plane, plane),
        isNull(mcpTokens.revokedAt),
      ),
    )
    .limit(1);
  if (!row) return null;
  void db
    .update(mcpTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(mcpTokens.id, row.id))
    .then(() => {});
  const grants = (row.grants as ApiGrant[] | null) && (row.grants as ApiGrant[]).length > 0 ? (row.grants as ApiGrant[]) : null;
  return { ...row, scopes: effectiveScopes(row.scopes), grants };
}
