/**
 * DAM (SPEC §2.5, Phase 4) — schema exists from v1 (secured up front for the patch purity rule)
 */
import {
  pgTable,
  uuid,
  text,
  integer,
  bigint,
  jsonb,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { workspaces, users } from "./identity.js";
import { entries } from "./content.js";

export const assets = pgTable(
  "assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** Virtual folder path (e.g. /products/2026) */
    folder: text("folder").default("/").notNull(),
    filename: text("filename").notNull(),
    mime: text("mime").notNull(),
    size: bigint("size", { mode: "number" }).notNull(),
    width: integer("width"),
    height: integer("height"),
    /**
     * Alternative text for accessibility (WCAG 1.1.1) — also consumed by delivery/populate.
     * Asset-level like Strapi's alternativeText: one description shared by every usage,
     * including images embedded in richtext. Empty string = intentionally decorative.
     */
    alt: text("alt"),
    /** EXIF etc. (T4.1) */
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
    /** S3 object key */
    storageKey: text("storage_key").notNull(),
    /** AssetStatus enum value */
    status: text("status").default("ready").notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("assets_storage_key_uq").on(t.storageKey),
    index("assets_ws_folder_idx").on(t.workspaceId, t.folder),
  ],
);

/** Usage tracking (T4.3): scan results of references in media fields and richtext */
export const assetUsages = pgTable(
  "asset_usages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    entryId: uuid("entry_id")
      .notNull()
      .references(() => entries.id, { onDelete: "cascade" }),
    field: text("field").notNull(),
  },
  (t) => [
    uniqueIndex("asset_usages_uq").on(t.assetId, t.entryId, t.field),
    index("asset_usages_entry_idx").on(t.entryId),
  ],
);
