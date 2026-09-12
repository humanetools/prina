/**
 * MCP tokens (T6.1) — issued/revoked per plane; management is role-bound (token↔role mapping).
 * [decision updated 2026-08-12] OAuth 2.1 authorization server implemented — remote MCP clients such as claude.ai
 * connect via DCR+PKCE and get mcp_tokens below issued (coexists with manual console issuance).
 */
import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { workspaces, users, roles } from "./identity.js";

export const mcpTokens = pgTable(
  "mcp_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** management | delivery */
    plane: text("plane").notNull(),
    /** AI identifier — recorded in the audit log as mcp:<name> (e.g. ops-01) */
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    /** management plane: commands run with this role's permissions (token↔role mapping) */
    roleId: uuid("role_id").references(() => roles.id, { onDelete: "cascade" }),
    /** delivery plane: locale scope (null = all) */
    localeScope: text("locale_scope"),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("mcp_tokens_ws_idx").on(t.workspaceId, t.plane),
    uniqueIndex("mcp_tokens_ws_name_uq").on(t.workspaceId, t.name),
  ],
);

/** OAuth 2.1 dynamically registered clients (RFC 7591) — claude.ai connector etc. */
export const oauthClients = pgTable("oauth_clients", {
  /** Exposed as-is as client_id */
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  redirectUris: jsonb("redirect_uris").$type<string[]>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/** OAuth authorization codes — single-use, 10-minute expiry, PKCE S256 */
export const oauthCodes = pgTable(
  "oauth_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    codeHash: text("code_hash").notNull().unique(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => oauthClients.id, { onDelete: "cascade" }),
    redirectUri: text("redirect_uri").notNull(),
    codeChallenge: text("code_challenge").notNull(),
    /** Consenting user — audit subject of the issued token */
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** management | delivery — confirmed on the consent screen */
    plane: text("plane").notNull(),
    roleId: uuid("role_id").references(() => roles.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("oauth_codes_client_idx").on(t.clientId)],
);
