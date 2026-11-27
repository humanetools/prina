/**
 * Version snapshots + audit log (SPEC §2.2, T1.5)
 * - content_versions: snapshot copy + diff on every save
 * - audit_log: append-only. No UPDATE; rows leave only through the retention policy an administrator sets (55-IMPL, EE)
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
  bigint,
  boolean,
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

/**
 * 55-IMPL — how long a workspace keeps its audit log and where new rows are forwarded. One row per
 * workspace. The table lives in core, the feature in EE: an OSS build never writes or reads it.
 */
export const auditSettings = pgTable("audit_settings", {
  workspaceId: uuid("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  /** null = keep forever */
  retentionDays: integer("retention_days"),
  streamUrl: text("stream_url"),
  /** Bearer token for the receiver, sealed with lib/secret-box */
  streamToken: text("stream_token"),
  streamEnabled: boolean("stream_enabled").default(false).notNull(),
  /** Highest audit_log.id already delivered */
  streamLastId: bigint("stream_last_id", { mode: "number" }).default(0).notNull(),
  streamLastSentAt: timestamp("stream_last_sent_at", { withTimezone: true }),
  streamLastError: text("stream_last_error"),
  /** Consecutive failed deliveries — drives the back-off */
  streamFailures: integer("stream_failures").default(0).notNull(),
  streamNextTryAt: timestamp("stream_next_try_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
