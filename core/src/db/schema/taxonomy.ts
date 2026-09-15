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
import { workspaces } from "./identity.js";
import { entries } from "./content.js";

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
     * Attribute set link (§2.8): component uid — entries under this category
     * get that component's attribute group exposed (feature is T2.5)
     */
    attributeComponentUid: text("attribute_component_uid"),
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
     * Attribute set values (§2.8) — validated against the node's attributeComponentUid component definition.
     * [decision] entries.values stays dedicated to the type schema,
     * and category-dependent attribute values are stored on the attach relation (values die with detach).
     */
    attributeValues: jsonb("attribute_values").$type<Record<string, unknown> | null>(),
  },
  (t) => [primaryKey({ columns: [t.entryId, t.nodeId] })],
);
