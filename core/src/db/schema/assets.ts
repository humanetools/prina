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
  primaryKey,
} from "drizzle-orm/pg-core";
import { workspaces, users } from "./identity.js";
import { entries } from "./content.js";

/** 46-IMPL — who gets what of a protected asset. Shape validated by the EE command that sets it. */
export interface AssetProtection {
  /** Watermark on admin previews for viewers without original access: workspace mark tiled, or + viewer identity */
  watermark: "tile" | "viewer";
  /** What the public /delivery/assets/:id serves */
  delivery: "clean" | "watermarked" | "blocked";
  /** Long-edge cap (px) of delivery derivatives — default 2560 */
  deliveryMaxEdge?: number;
  /**
   * Invisible recipient code (46-IMPL G3) in downloaded originals — default true. The file is then a
   * re-encode of the original (same size and format family); set false when the untouched file is required.
   */
  traceOriginal?: boolean;
}

/**
 * 46-IMPL G5 — what the workspace is allowed to do with an asset, and until when. A record for people:
 * nothing here is enforced on delivery; an expired asset is only flagged in the admin.
 */
export interface AssetRights {
  /** Who holds the rights / who licensed it */
  holder?: string;
  /** Contract or licence reference */
  source?: string;
  /** First and last day of permitted use, YYYY-MM-DD */
  validFrom?: string;
  expiresAt?: string;
  /** Permitted regions and channels — shown only, never enforced */
  regions?: string;
  channels?: string;
  note?: string;
}

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
    /**
     * Protection policy (46-IMPL asset governance) — null = unprotected. The record lives in core,
     * the enforcement in EE (same split as audit/versioning): an OSS build never sets or reads it.
     */
    protection: jsonb("protection").$type<AssetProtection>(),
    /**
     * Content fingerprint (46-IMPL G4) — 63 low-frequency DCT terms as hex (see ee fingerprint.ts). Written by EE for
     * protected image assets; lets a copy found elsewhere be matched to its asset without any watermark.
     */
    fingerprint: text("fingerprint"),
    /** Usage rights (46-IMPL G5) — null = nothing recorded. Written by EE only. */
    rights: jsonb("rights").$type<AssetRights>(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("assets_storage_key_uq").on(t.storageKey),
    index("assets_ws_folder_idx").on(t.workspaceId, t.folder),
  ],
);

/**
 * Folder register (24-IMPL-dam-folder-tree) — lets a folder exist before (or after) it holds assets.
 * An asset's folder stays the plain `assets.folder` path; this table only says "this path exists".
 */
export const assetFolders = pgTable(
  "asset_folders",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.path] })],
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

/**
 * 46-IMPL G5 — a proposed change to an asset's rights, waiting for someone with system:media_rights.
 * Approved = the proposal was written to assets.rights at decision time.
 */
export const assetRightsRequests = pgTable(
  "asset_rights_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    /** The rights record as proposed (empty object = clear the record) */
    proposed: jsonb("proposed").$type<AssetRights>().notNull(),
    note: text("note"),
    /** pending | approved | rejected */
    status: text("status").default("pending").notNull(),
    requestedBy: text("requested_by"),
    requestedByLabel: text("requested_by_label"),
    decidedBy: text("decided_by"),
    decidedByLabel: text("decided_by_label"),
    decisionNote: text("decision_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
  },
  (t) => [
    index("asset_rights_requests_ws_status_idx").on(t.workspaceId, t.status),
    index("asset_rights_requests_asset_idx").on(t.assetId),
  ],
);
