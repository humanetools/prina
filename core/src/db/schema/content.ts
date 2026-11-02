/**
 * Content types & entries (SPEC §2.1~2.2 — the heart of the product)
 * - content_types.definition (JSONB) is the single source of schema (absolute principle 3)
 * - entries.values (JSONB) + generated column extension point (comment below)
 * - KG slots (absolute principle 5): content_types.schema_org_type, entry_relations.predicate
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
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import type { ContentTypeDefinition, EntryAiDraft, EntrySeo } from "@prina/shared";
import { contentTypeKindEnum, entryStatusEnum } from "./enums.js";
import { workspaces, users } from "./identity.js";
import { workflows } from "./workflow.js";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
};

export const contentTypes = pgTable(
  "content_types",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** API identifier (e.g. product, article) — used in REST paths and MCP tool names */
    uid: text("uid").notNull(),
    kind: contentTypeKindEnum("kind").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    /** KG slot (§2.7): schema.org type mapping — v1 only stores it, feature is Phase 9 */
    schemaOrgType: text("schema_org_type"),
    /** Secondary schema.org type — 2nd item of the JSON-LD @type array (e.g. Product + Offer) */
    schemaOrgSecondary: text("schema_org_secondary"),
    /** Field definitions — shared derivation source for JSON Schema, OpenAPI, MCP tools */
    definition: jsonb("definition").$type<ContentTypeDefinition>().notNull(),
    options: jsonb("options").$type<Record<string, unknown>>().default({}).notNull(),
    workflowId: uuid("workflow_id").references(() => workflows.id, {
      onDelete: "set null",
    }),
    /** Incremented on definition change — cache invalidation key for the schema pipeline (T1.3) */
    version: integer("version").default(1).notNull(),
    /** Admin navigation folder (38-IMPL) — `/` = unfiled, `/a/b` = a path in the folder tree of this type's kind */
    folder: text("folder").default("/").notNull(),
    ...timestamps,
  },
  (t) => [uniqueIndex("content_types_ws_uid_uq").on(t.workspaceId, t.uid)],
);

/**
 * Content-type folder register (38-IMPL) — lets a folder exist while no type is filed in it. The tree is the
 * union of these paths, the folders content types actually sit in, and their ancestors. Folders are scoped
 * per kind: the admin shows Collection Types and Single Types as separate trees.
 */
export const contentTypeFolders = pgTable(
  "content_type_folders",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    kind: contentTypeKindEnum("kind").notNull(),
    path: text("path").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.kind, t.path] })],
);

export const components = pgTable(
  "components",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    uid: text("uid").notNull(),
    name: text("name").notNull(),
    definition: jsonb("definition").$type<ContentTypeDefinition>().notNull(),
    version: integer("version").default(1).notNull(),
    /**
     * Component options (40-IMPL) — known keys are validated, unknown keys pass through.
     * `markup: true` declares the component a render unit: the template partial named by its uid
     * (liquid + css + js) can be saved and is served by delivery.
     */
    options: jsonb("options").$type<Record<string, unknown>>().default({}).notNull(),
    /** Admin navigation folder (42-IMPL) — `/` = unfiled; a path in the component folder tree */
    folder: text("folder").default("/").notNull(),
    ...timestamps,
  },
  (t) => [uniqueIndex("components_ws_uid_uq").on(t.workspaceId, t.uid)],
);

/**
 * Component folder register (42-IMPL) — same contract as content_type_folders with a single namespace:
 * a path exists while registered or while a component sits in it (or under it).
 */
export const componentFolders = pgTable(
  "component_folders",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.path] })],
);

export const entries = pgTable(
  "entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    contentTypeId: uuid("content_type_id")
      .notNull()
      .references(() => contentTypes.id, { onDelete: "cascade" }),
    /** i18n group — shared by per-locale entries of the same document (§2.3 document-level) */
    documentId: uuid("document_id").notNull().defaultRandom(),
    locale: text("locale").notNull(),
    status: entryStatusEnum("status").default("draft").notNull(),
    values: jsonb("values").$type<Record<string, unknown>>().default({}).notNull(),
    /**
     * Extracted text for search (including richtext, filled in T1.8).
     * [generated column extension point] Per-type fields needing query performance
     * are extended via the ALTER TABLE entries ADD COLUMN x GENERATED ALWAYS AS (values->>'x') STORED
     * pattern — SPEC §2.1.
     */
    searchText: text("search_text"),
    /** Variants (§2.8): self-reference from child SKU to its parent */
    parentEntryId: uuid("parent_entry_id").references((): AnyPgColumn => entries.id, {
      onDelete: "cascade",
    }),
    /** Child SKU's axis option combo (e.g. {"Color":"Red"}) — null for parents */
    variantValues: jsonb("variant_values").$type<Record<string, string> | null>(),
    completeness: jsonb("completeness").$type<{ score: number } | null>(),
    /** Per-entry SEO record (§0.11) — outside values: the compiled schema rejects unknown keys */
    seo: jsonb("seo").$type<EntrySeo | null>(),
    /** AI-draft provenance (IMPL-ai-locale-translation) — null once a human saves/transitions */
    aiDraft: jsonb("ai_draft").$type<EntryAiDraft | null>(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("entries_document_locale_uq").on(t.documentId, t.locale),
    index("entries_ws_type_idx").on(t.workspaceId, t.contentTypeId),
    index("entries_status_idx").on(t.workspaceId, t.status),
    index("entries_parent_idx").on(t.parentEntryId),
  ],
);

export const entryRelations = pgTable(
  "entry_relations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    fromEntryId: uuid("from_entry_id")
      .notNull()
      .references(() => entries.id, { onDelete: "cascade" }),
    toEntryId: uuid("to_entry_id")
      .notNull()
      .references(() => entries.id, { onDelete: "cascade" }),
    /** Name of the relation field on the source entry */
    field: text("field").notNull(),
    /** KG slot (§2.7): semantic predicate (e.g. compatibleWith) — feature is Phase 9 */
    predicate: text("predicate"),
    position: integer("position").default(0).notNull(),
  },
  (t) => [
    index("entry_relations_from_idx").on(t.fromEntryId, t.field),
    index("entry_relations_to_idx").on(t.toEntryId),
  ],
);
