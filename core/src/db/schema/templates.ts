/**
 * Template bundles (SPEC §2.4, Phase 5) — the liquid+css+js trio forms one version unit
 * Version = per row (version increments for the same name). The published version maps to the serving URL /templates/{type}/v{n}/...
 */
import {
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  boolean,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { workspaces } from "./identity.js";
import { contentTypes } from "./content.js";

export const templates = pgTable(
  "templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    contentTypeId: uuid("content_type_id")
      .notNull()
      .references(() => contentTypes.id, { onDelete: "cascade" }),
    name: text("name").default("default").notNull(),
    version: integer("version").notNull(),
    liquid: text("liquid").default("").notNull(),
    css: text("css").default("").notNull(),
    /** script.js — developer role only (T5.3 locked on both UI and API) */
    js: text("js").default("").notNull(),
    /** GA4 dataLayer event mapping (T5.4): catalog events & fields → standard variables */
    events: jsonb("events").$type<Record<string, unknown>>().default({}).notNull(),
    isCurrent: boolean("is_current").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("templates_ws_type_name_ver_uq").on(
      t.workspaceId,
      t.contentTypeId,
      t.name,
      t.version,
    ),
    index("templates_type_idx").on(t.contentTypeId),
  ],
);
