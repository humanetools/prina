/**
 * Scheduled publishing (54-IMPL).
 *  - entry_schedules: one entry, one moment, publish or unpublish — every edition.
 *  - content_releases (+ items): several entries published or unpublished together. The tables live in
 *    core, the feature in EE (same split as asset protection): an OSS build never writes or reads them.
 */
import { index, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { workspaces } from "./identity.js";
import { entries } from "./content.js";

export const entrySchedules = pgTable(
  "entry_schedules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    entryId: uuid("entry_id")
      .notNull()
      .references(() => entries.id, { onDelete: "cascade" }),
    typeUid: text("type_uid").notNull(),
    /** publish | unpublish */
    action: text("action").notNull(),
    runAt: timestamp("run_at", { withTimezone: true }).notNull(),
    /** pending | running | done | failed | cancelled */
    status: text("status").default("pending").notNull(),
    /** The user whose rights the run uses */
    scheduledBy: text("scheduled_by"),
    scheduledByLabel: text("scheduled_by_label"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    executedAt: timestamp("executed_at", { withTimezone: true }),
    /** Why a run failed — shown on the entry */
    error: text("error"),
  },
  (t) => [
    index("entry_schedules_due_idx").on(t.status, t.runAt),
    index("entry_schedules_entry_idx").on(t.entryId),
  ],
);

/** Outcome of one release item at run (or check) time */
export interface ReleaseItemResult {
  entryId: string;
  ok: boolean;
  error?: string;
}

export const contentReleases = pgTable(
  "content_releases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** publish | unpublish */
    action: text("action").notNull(),
    runAt: timestamp("run_at", { withTimezone: true }),
    /** open | scheduled | running | done | failed */
    status: text("status").default("open").notNull(),
    createdBy: text("created_by"),
    createdByLabel: text("created_by_label"),
    /** The user whose rights the run uses — whoever scheduled or started it */
    runBy: text("run_by"),
    runByLabel: text("run_by_label"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    executedAt: timestamp("executed_at", { withTimezone: true }),
    result: jsonb("result").$type<ReleaseItemResult[]>(),
  },
  (t) => [index("content_releases_due_idx").on(t.status, t.runAt), index("content_releases_ws_idx").on(t.workspaceId, t.createdAt)],
);

export const contentReleaseItems = pgTable(
  "content_release_items",
  {
    releaseId: uuid("release_id")
      .notNull()
      .references(() => contentReleases.id, { onDelete: "cascade" }),
    entryId: uuid("entry_id")
      .notNull()
      .references(() => entries.id, { onDelete: "cascade" }),
    typeUid: text("type_uid").notNull(),
    addedByLabel: text("added_by_label"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.releaseId, t.entryId] }), index("content_release_items_entry_idx").on(t.entryId)],
);
