/** MCP token commands (T6.1/T6.4) — issue, revoke, verify. Token↔role mapping */
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { and, desc, eq, isNull } from "drizzle-orm";
import { McpPlane, PermissionAction, SystemSubject } from "@prina/shared";
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
  }),
  permission: mcpPermission(PermissionAction.Create),
  async execute(input, ctx) {
    if (input.plane === McpPlane.Management) {
      if (!input.roleId) {
        throw new ValidationError("A management token needs a role binding");
      }
      const [role] = await ctx.db
        .select({ id: roles.id })
        .from(roles)
        .where(and(eq(roles.workspaceId, ctx.workspaceId), eq(roles.id, input.roleId)))
        .limit(1);
      if (!role) throw new ValidationError("That role is not in this workspace");
    }
    const [dup] = await ctx.db
      .select({ id: mcpTokens.id })
      .from(mcpTokens)
      .where(
        and(
          eq(mcpTokens.workspaceId, ctx.workspaceId),
          eq(mcpTokens.name, input.name),
          isNull(mcpTokens.revokedAt),
        ),
      )
      .limit(1);
    if (dup) throw new ConflictError(`An active token named '${input.name}' already exists`);

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
        createdBy: ctx.actor.type === "human" ? (ctx.actor.id ?? null) : null,
      })
      .returning();
    // the raw token is exposed only once, in this response
    return { token: raw, record: { ...row!, tokenHash: undefined } };
  },
  resourceId: (_i, o) => o.record.id,
  auditPayload: (i) => ({ plane: i.plane, name: i.name }),
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
        lastUsedAt: mcpTokens.lastUsedAt,
        revokedAt: mcpTokens.revokedAt,
        createdAt: mcpTokens.createdAt,
      })
      .from(mcpTokens)
      .where(eq(mcpTokens.workspaceId, ctx.workspaceId))
      .orderBy(desc(mcpTokens.createdAt));
    return rows;
  },
});

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
  return row;
}
