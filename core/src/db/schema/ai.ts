/**
 * AI translation glossary (37-IMPL-translation-glossary) — workspace-scoped term rows the
 * locale translator must honour. One row = one concept; `terms` maps a locale code to that
 * concept's wording, so adding or removing a locale never touches this schema.
 */
import { pgTable, uuid, integer, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { workspaces } from "./identity.js";

export const aiGlossaryTerms = pgTable(
  "ai_glossary_terms",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** Display order in the glossary grid (0-based, dense after every save) */
    position: integer("position").default(0).notNull(),
    /** { "<locale code>": "<term in that locale>" } — missing or empty = no wording yet */
    terms: jsonb("terms").$type<Record<string, string>>().default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("ai_glossary_terms_ws_idx").on(t.workspaceId, t.position)],
);
