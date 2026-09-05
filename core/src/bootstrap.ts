/**
 * Startup seed — default workspace, locale, and workflow preset.
 * [Planned for Phase 2] The setup wizard (T2.1) replaces these values with real settings.
 * Idempotent: existing records are left untouched.
 */
import { and, eq } from "drizzle-orm";
import { EntryStatus } from "@prina/shared";
import type { Db } from "./db/client.js";
import type { WorkflowPreset } from "./ee-loader.js";
import { locales, workflows, workflowTransitions, workspaces } from "./db/schema/index.js";
import { seedDefaultRoles } from "./modules/rbac/roles-seed.js";

/**
 * Core (OSS) workflow preset: draft↔published 2-state (strategy doc §feature boundary).
 * The 4-state submit/approve preset is provided by EE (ee-loader's workflowPreset).
 */
export const CORE_WORKFLOW_PRESET: WorkflowPreset = {
  states: [EntryStatus.Draft, EntryStatus.Published],
  transitions: [
    [EntryStatus.Draft, EntryStatus.Published],
    [EntryStatus.Published, EntryStatus.Draft],
  ],
};

export async function bootstrap(db: Db, preset?: WorkflowPreset): Promise<{ workspaceId: string }> {
  let [ws] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.slug, "default"))
    .limit(1);
  if (!ws) {
    [ws] = await db
      .insert(workspaces)
      .values({ slug: "default", name: "Default Workspace" })
      .returning();
  }
  const workspaceId = ws!.id;
  await seedWorkspaceDefaults(db, workspaceId, preset);
  return { workspaceId };
}

/** Per-workspace defaults seed — also reused by tests and the workspace-create command */
export async function seedWorkspaceDefaults(
  db: Db,
  workspaceId: string,
  preset: WorkflowPreset = CORE_WORKFLOW_PRESET,
): Promise<void> {
  const [koLocale] = await db
    .select()
    .from(locales)
    .where(and(eq(locales.workspaceId, workspaceId), eq(locales.code, "ko")))
    .limit(1);
  if (!koLocale) {
    await db
      .insert(locales)
      .values({ workspaceId, code: "ko", name: "Korean", isDefault: true });
  }

  const [wf] = await db
    .select()
    .from(workflows)
    .where(and(eq(workflows.workspaceId, workspaceId), eq(workflows.isDefault, true)))
    .limit(1);
  if (!wf) {
    const [created] = await db
      .insert(workflows)
      .values({
        workspaceId,
        name: "Default workflow",
        states: preset.states,
        isDefault: true,
      })
      .returning();
    await db.insert(workflowTransitions).values(
      preset.transitions.map(([fromState, toState]) => ({
        workspaceId,
        workflowId: created!.id,
        fromState,
        toState,
        allowedRoleIds: null, // Unrestricted by default — role guard configured in Settings (T2.3, EE)
      })),
    );
  }

  // Default role preset (T2.2): admin/developer/editor/publisher
  await seedDefaultRoles(db, workspaceId);
}
