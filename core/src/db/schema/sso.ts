/**
 * Single sign-on (49-IMPL) — connections to an identity provider, the identities they vouch for,
 * and SCIM provisioning state. The tables are part of the core schema (every edition migrates the
 * same database); the code that reads them lives in the commercial edition.
 */
import {
  pgTable,
  uuid,
  text,
  boolean,
  jsonb,
  timestamp,
  uniqueIndex,
  index,
  primaryKey,
} from "drizzle-orm/pg-core";
import { roles, users, workspaces } from "./identity.js";

/** Non-secret settings of a connection. OIDC and SAML keep different keys in the same column. */
export interface SsoConnectionConfig {
  /** OIDC */
  issuer?: string;
  clientId?: string;
  scopes?: string;
  /** SAML — identity provider side */
  idpEntityId?: string;
  idpSsoUrl?: string;
  /** PEM bodies (base64, no armor) of the certificates the provider signs with */
  idpCertificates?: string[];
  /** Attribute names carrying the address and the display name; unset = common defaults */
  emailAttribute?: string;
  nameAttribute?: string;
}

/** An identity provider people of this install sign in through (instance-wide) */
export const ssoConnections = pgTable("sso_connections", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** oidc | saml */
  kind: text("kind").notNull(),
  /** Shown on the sign-in button */
  name: text("name").notNull(),
  config: jsonb("config").$type<SsoConnectionConfig>().default({}).notNull(),
  /** Client secret, sealed with PRINA_SECRET_KEY (lib/secret-box) — never stored in the clear */
  secretEnc: text("secret_enc"),
  /** Address domains that may get an account on first sign-in; empty = only linked accounts sign in */
  emailDomains: jsonb("email_domains").$type<string[]>().default([]).notNull(),
  /** Where a first-time account lands */
  defaultWorkspaceId: uuid("default_workspace_id").references(() => workspaces.id, { onDelete: "set null" }),
  defaultRoleId: uuid("default_role_id").references(() => roles.id, { onDelete: "set null" }),
  enabled: boolean("enabled").default(true).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * A provider identity bound to a local account. `subject` is the provider's stable id; a row with
 * no subject yet is a link an administrator (or SCIM) prepared — it binds on that person's first sign-in.
 */
export const userIdentities = pgTable(
  "user_identities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => ssoConnections.id, { onDelete: "cascade" }),
    subject: text("subject"),
    /** Lowercased address the provider reported (or the one a prepared link waits for) */
    email: text("email"),
    /** The provider's own key for this person when it provisions over SCIM */
    externalId: text("external_id"),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("user_identities_conn_subject_uq").on(t.connectionId, t.subject),
    uniqueIndex("user_identities_conn_user_uq").on(t.connectionId, t.userId),
    index("user_identities_user_idx").on(t.userId),
  ],
);

/**
 * A sign-in that left for the provider and has not come back yet. One row per attempt, deleted when
 * the answer is consumed — which is also what makes a nonce or a SAML response single-use.
 */
export const ssoLoginStates = pgTable(
  "sso_login_states",
  {
    /** sha256 of the state value (OIDC) or the request id (SAML) */
    id: text("id").primaryKey(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => ssoConnections.id, { onDelete: "cascade" }),
    data: jsonb("data").$type<Record<string, unknown>>().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("sso_login_states_expires_idx").on(t.expiresAt)],
);

/** Bearer tokens an identity provider provisions with (SCIM 2.0). Only the hash is kept. */
export const scimTokens = pgTable("scim_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  connectionId: uuid("connection_id")
    .notNull()
    .references(() => ssoConnections.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/** A group the provider pushed. Mapping it to a role is the administrator's decision. */
export const scimGroups = pgTable(
  "scim_groups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => ssoConnections.id, { onDelete: "cascade" }),
    displayName: text("display_name").notNull(),
    externalId: text("external_id"),
    /** Members of the group hold this role in this workspace; unset = the group grants nothing */
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "set null" }),
    roleId: uuid("role_id").references(() => roles.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("scim_groups_conn_name_uq").on(t.connectionId, t.displayName)],
);

export const scimGroupMembers = pgTable(
  "scim_group_members",
  {
    groupId: uuid("group_id")
      .notNull()
      .references(() => scimGroups.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.userId] }), index("scim_group_members_user_idx").on(t.userId)],
);
