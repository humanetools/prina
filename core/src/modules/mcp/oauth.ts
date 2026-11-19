/**
 * OAuth 2.1 authorization server (§2.6) — for remote MCP clients such as claude.ai.
 * Supports only DCR (RFC 7591) + authorization code + PKCE S256 (public client, no secret).
 * Token exchange issues an existing mcp_tokens record — reusing validation, permission, and audit as-is.
 */
import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { McpPlane } from "@prina/shared";
import { auditLog, mcpTokens, oauthClients, oauthCodes } from "../../db/schema/index.js";
import type { Db } from "../../db/client.js";

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");
const b64url = (buf: Buffer) =>
  buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export const CODE_TTL_MS = 10 * 60 * 1000;

export interface OAuthError { error: string; error_description: string; }
const oauthError = (error: string, desc: string): OAuthError => ({ error, error_description: desc });

/** RFC 7591 dynamic client registration — redirect_uri must be https (or localhost http) */
export async function registerClient(
  db: Db,
  body: Record<string, unknown>,
): Promise<Record<string, unknown> | OAuthError> {
  const uris = Array.isArray(body.redirect_uris) ? (body.redirect_uris as unknown[]) : [];
  const redirectUris = uris.filter((u): u is string => typeof u === "string");
  if (redirectUris.length === 0) {
    return oauthError("invalid_client_metadata", "redirect_uris is required");
  }
  for (const uri of redirectUris) {
    let parsed: URL;
    try { parsed = new URL(uri); } catch {
      return oauthError("invalid_redirect_uri", `Not a valid URL: ${uri}`);
    }
    const isLocal = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLocal)) {
      return oauthError("invalid_redirect_uri", "redirect_uris must be https (or localhost http)");
    }
  }
  const name = typeof body.client_name === "string" && body.client_name.trim()
    ? body.client_name.trim().slice(0, 120)
    : "MCP client";
  const [row] = await db
    .insert(oauthClients)
    .values({ name, redirectUris })
    .returning();
  return {
    client_id: row!.id,
    client_name: name,
    redirect_uris: redirectUris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code"],
    response_types: ["code"],
  };
}

export async function getClient(db: Db, clientId: string) {
  if (!/^[0-9a-f-]{36}$/.test(clientId)) return null;
  const [row] = await db.select().from(oauthClients).where(eq(oauthClients.id, clientId)).limit(1);
  return row ?? null;
}

/** Consent approved → issue single-use authorization code */
export async function createAuthCode(
  db: Db,
  input: {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    userId: string;
    workspaceId: string;
    plane: string;
    roleId: string | null;
  },
): Promise<string> {
  const code = b64url(randomBytes(32));
  await db.insert(oauthCodes).values({
    codeHash: sha256(code),
    clientId: input.clientId,
    redirectUri: input.redirectUri,
    codeChallenge: input.codeChallenge,
    userId: input.userId,
    workspaceId: input.workspaceId,
    plane: input.plane,
    roleId: input.roleId,
    expiresAt: new Date(Date.now() + CODE_TTL_MS),
  });
  return code;
}

/** Token name — random suffix to satisfy the mcp_tokens unique constraint (ws,name) */
function tokenName(clientName: string): string {
  const slug = clientName.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "client";
  return `oauth-${slug}-${randomBytes(3).toString("hex")}`;
}

/** Authorization code → MCP token exchange (PKCE S256 verified, code is single-use) */
export async function exchangeCode(
  db: Db,
  input: { code: string; clientId: string; redirectUri?: string; codeVerifier: string },
): Promise<{ access_token: string; token_type: string; scope: string } | OAuthError> {
  const [row] = await db
    .select()
    .from(oauthCodes)
    .where(and(eq(oauthCodes.codeHash, sha256(input.code)), isNull(oauthCodes.usedAt)))
    .limit(1);
  if (!row) return oauthError("invalid_grant", "Unknown or already used code");
  if (row.expiresAt.getTime() < Date.now()) return oauthError("invalid_grant", "Code expired");
  if (row.clientId !== input.clientId) return oauthError("invalid_grant", "Client mismatch");
  if (input.redirectUri && row.redirectUri !== input.redirectUri) {
    return oauthError("invalid_grant", "redirect_uri mismatch");
  }
  const challenge = b64url(createHash("sha256").update(input.codeVerifier).digest());
  if (challenge !== row.codeChallenge) return oauthError("invalid_grant", "PKCE verification failed");

  // Mark code as used, then issue the token
  await db.update(oauthCodes).set({ usedAt: new Date() }).where(eq(oauthCodes.id, row.id));

  const client = await getClient(db, row.clientId);
  const prefix = row.plane === McpPlane.Management ? "pmt_mgmt_" : "pmt_dlv_";
  const token = `${prefix}${b64url(randomBytes(24))}`;
  const [record] = await db
    .insert(mcpTokens)
    .values({
      workspaceId: row.workspaceId,
      plane: row.plane,
      name: tokenName(client?.name ?? "client"),
      tokenHash: sha256(token),
      roleId: row.roleId,
      createdBy: row.userId,
    })
    .returning();
  // Audit — logged under the same action as console issuance (mcp_token.create command)
  await db.insert(auditLog).values({
    workspaceId: row.workspaceId,
    actorType: "human",
    actorId: row.userId,
    actorLabel: null,
    action: "mcp_token.create",
    resourceType: "mcp_token",
    resourceId: record!.id,
    payload: { via: "oauth", client: client?.name ?? null, plane: row.plane, name: record!.name },
  });
  return { access_token: token, token_type: "bearer", scope: row.plane };
}
