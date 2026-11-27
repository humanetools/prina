/**
 * Taxonomy (SPEC §2.8, T2.5)
 * Hierarchy representation = **ltree adopted** (choice record: fewer moving parts and maintenance code than a
 * closure table, and subtree queries are solved with a single index — Postgres extensions allowed by absolute principle 1).
 * path example: "root.electronics.camera" (label = ltree-safe conversion of the slug)
 */
import {
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  timestamp,
  uniqueIndex,
  index,
  primaryKey,
  customType,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import type { TaxonomyAttributeField } from "@prina/shared";
import { workspaces } from "./identity.js";
import { entries } from "./content.js";
import { assets } from "./assets.js";

export const ltree = customType<{ data: string }>({
  dataType() {
    return "ltree";
  },
});

export const taxonomies = pgTable(
  "taxonomies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    uid: text("uid").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    /** Attribute definitions (33-IMPL) — every node of this taxonomy carries values for these */
    attributeFields: jsonb("attribute_fields").$type<TaxonomyAttributeField[]>().default([]).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("taxonomies_ws_uid_uq").on(t.workspaceId, t.uid)],
);

export const taxonomyNodes = pgTable(
  "taxonomy_nodes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    taxonomyId: uuid("taxonomy_id")
      .notNull()
      .references(() => taxonomies.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id").references((): AnyPgColumn => taxonomyNodes.id, {
      onDelete: "cascade",
    }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    path: ltree("path").notNull(),
    /**
     * Entry component (§2.8, named "attribute set" until 33-IMPL): component uid — entries under this
     * category get that component's fields exposed. The column keeps its original name.
     */
    entryComponentUid: text("attribute_component_uid"),
    /** Attribute values of the node itself (33-IMPL) — keys are the taxonomy's attributeFields names */
    attributes: jsonb("attributes").$type<Record<string, unknown>>().default({}).notNull(),
    position: integer("position").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("taxonomy_nodes_tax_slug_uq").on(t.taxonomyId, t.path),
    index("taxonomy_nodes_path_gist").using("gist", t.path),
  ],
);

/** Multi-category attach for entries (T2.5) */
export const entryTaxonomyNodes = pgTable(
  "entry_taxonomy_nodes",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    entryId: uuid("entry_id")
      .notNull()
      .references(() => entries.id, { onDelete: "cascade" }),
    nodeId: uuid("node_id")
      .notNull()
      .references(() => taxonomyNodes.id, { onDelete: "cascade" }),
    /**
     * Entry component values (§2.8) — validated against the node's entryComponentUid component definition.
     * [decision] entries.values stays dedicated to the type schema,
     * and category-dependent values are stored on the attach relation (values die with detach).
     * The column keeps its pre-33-IMPL name.
     */
    entryComponentValues: jsonb("attribute_values").$type<Record<string, unknown> | null>(),
  },
  (t) => [primaryKey({ columns: [t.entryId, t.nodeId] })],
);

/**
 * Multi-category attach for assets (23-IMPL-dam-taxonomy) — the same nodes entries use.
 * No entry-component values here: an asset's own metadata (alt, EXIF, analysis) already lives on the asset.
 */
export const assetTaxonomyNodes = pgTable(
  "asset_taxonomy_nodes",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    nodeId: uuid("node_id")
      .notNull()
      .references(() => taxonomyNodes.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.assetId, t.nodeId] }),
    index("asset_taxonomy_nodes_node_idx").on(t.nodeId),
  ],
);
