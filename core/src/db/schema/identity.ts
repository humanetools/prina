/**
 * Workspaces, users, permissions (SPEC §3.3 two-tier tenancy)
 * - workspaces = tenancy tier 2 (per-brand/country sites). Every core table has workspace_id (absolute principle 4).
 * - users are instance-tier (tier 1) — workspace membership is determined via roles (workspace-scoped).
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

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
};

export const workspaces = pgTable("workspaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  /** Workspace settings (global defaults such as default locale, GA4 currency) */
  settings: jsonb("settings").$type<Record<string, unknown>>().default({}).notNull(),
  ...timestamps,
});

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  /**
   * Login identifier. A self-hosted install's first account is a local admin, not a
   * mailing-list entry — asking for an email there only to ask again for a work email
   * during MCP setup read as the same question twice (decided 2026-08-17).
   * Intentional divergence from Strapi, which logs in by email — see STRAPI-DIFF.md.
   */
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash"),
  name: text("name").notNull(),
  /** Instance admin (created by the setup wizard) */
  isInstanceAdmin: boolean("is_instance_admin").default(false).notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  ...timestamps,
});

export const roles = pgTable(
  "roles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    isSystem: boolean("is_system").default(false).notNull(),
    ...timestamps,
  },
  (t) => [uniqueIndex("roles_ws_name_uq").on(t.workspaceId, t.name)],
);

/**
 * Permissions: type×CRUD×field level×locale (T2.2).
 * null fields/locales means all allowed; an array allows only the listed items.
 */
export const permissions = pgTable(
  "permissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    /** PermissionAction enum value */
    action: text("action").notNull(),
    /** Target: content type uid, system resource key ('content_type_builder' etc.), '*' */
    subject: text("subject").notNull(),
    fields: jsonb("fields").$type<string[] | null>(),
    locales: jsonb("locales").$type<string[] | null>(),
    conditions: jsonb("conditions").$type<Record<string, unknown> | null>(),
    ...timestamps,
  },
  (t) => [index("permissions_role_idx").on(t.roleId)],
);

export const userRoles = pgTable(
  "user_roles",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.userId, t.roleId] })],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export const locales = pgTable(
  "locales",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** BCP 47 (ko, en, ja ...) */
    code: text("code").notNull(),
    name: text("name").notNull(),
    isDefault: boolean("is_default").default(false).notNull(),
    ...timestamps,
  },
  (t) => [uniqueIndex("locales_ws_code_uq").on(t.workspaceId, t.code)],
);
