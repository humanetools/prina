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

/**
 * Template partials (39-IMPL) — reusable Liquid fragments resolved by `{% render 'name' %}`.
 * One row per saved version (same name → version increments); one current per name.
 * `liquid_edit` is the authoring variant carrying `data-blk`/`data-prop` markers (preview only).
 */
export const templatePartials = pgTable(
  "template_partials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    version: integer("version").notNull(),
    liquid: text("liquid").default("").notNull(),
    liquidEdit: text("liquid_edit").default("").notNull(),
    /** style.css of the partial (40-IMPL) — served version-pinned, scoped to the page root like templates.css */
    css: text("css").default("").notNull(),
    /** script.js of the partial — developer role only, same lock as templates.js */
    js: text("js").default("").notNull(),
    isCurrent: boolean("is_current").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("template_partials_ws_name_ver_uq").on(t.workspaceId, t.name, t.version),
    index("template_partials_ws_current_idx").on(t.workspaceId, t.isCurrent),
  ],
);
