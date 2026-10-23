/**
 * Workflow state machine + transition guard (SPEC §2.3, T2.3)
 * Default preset: draft → review → approved → published
 */
import {
  pgTable,
  uuid,
  text,
  boolean,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { workspaces } from "./identity.js";

export const workflows = pgTable(
  "workflows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** State list (EntryStatus values, ordered) */
    states: jsonb("states").$type<string[]>().notNull(),
    isDefault: boolean("is_default").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("workflows_ws_name_uq").on(t.workspaceId, t.name)],
);

/** Transition×role guard — null allowedRoleIds means all roles allowed */
export const workflowTransitions = pgTable(
  "workflow_transitions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    fromState: text("from_state").notNull(),
    toState: text("to_state").notNull(),
    allowedRoleIds: jsonb("allowed_role_ids").$type<string[] | null>(),
  },
  (t) => [index("workflow_transitions_wf_idx").on(t.workflowId)],
);
