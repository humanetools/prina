/**
 * Version snapshots + audit log (SPEC §2.2, T1.5)
 * - content_versions: snapshot copy + diff on every save
 * - audit_log: append-only. No UPDATE/DELETE (to be enforced by application convention + DB permissions)
 * - The actor_type human|ai distinction is a product differentiator — required on every recording path
 */
import {
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  timestamp,
  bigserial,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import type { EntrySeo } from "@prina/shared";
import { actorTypeEnum } from "./enums.js";
import { workspaces } from "./identity.js";
import { entries } from "./content.js";

export interface EntrySnapshot {
  values: Record<string, unknown>;
  status: string;
  locale: string;
  variantValues?: Record<string, string> | null;
  /** SEO record at snapshot time — absent on versions recorded before the SEO feature */
  seo?: EntrySeo | null;
}

export const contentVersions = pgTable(
  "content_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    entryId: uuid("entry_id")
      .notNull()
      .references(() => entries.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    snapshot: jsonb("snapshot").$type<EntrySnapshot>().notNull(),
    /** Field-level diff against the previous version: { field: { before, after } } */
    diff: jsonb("diff").$type<Record<string, { before: unknown; after: unknown }>>(),
    actorType: actorTypeEnum("actor_type").notNull(),
    actorId: text("actor_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("content_versions_entry_ver_uq").on(t.entryId, t.version)],
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    /** null for instance-level events such as workspace creation */
    workspaceId: uuid("workspace_id").references(() => workspaces.id, {
      onDelete: "set null",
    }),
    actorType: actorTypeEnum("actor_type").notNull(),
    /** human=user id, ai=MCP token/client identifier (e.g. mcp:ops-01) */
    actorId: text("actor_id"),
    actorLabel: text("actor_label"),
    /** Command name (e.g. entry.create) */
    action: text("action").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id"),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("audit_log_ws_idx").on(t.workspaceId, t.createdAt),
    index("audit_log_actor_idx").on(t.actorType, t.actorId),
  ],
);
