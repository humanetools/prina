/** Workspace settings commands — global dataLayer defaults (currency etc., T5.4/P11 system) */
import { z } from "zod";
import { eq } from "drizzle-orm";
import { PermissionAction, SystemSubject } from "@prina/shared";
import { workspaces } from "../../db/schema/index.js";
import { defineCommand } from "../../commands/define.js";

export const workspaceGetSettings = defineCommand({
  name: "workspace.get_settings",
  resource: "workspace",
  skipAudit: true,
  input: z.object({}).default({}),
  async execute(_input, ctx) {
    const [ws] = await ctx.db
      .select({ id: workspaces.id, name: workspaces.name, settings: workspaces.settings })
      .from(workspaces)
      .where(eq(workspaces.id, ctx.workspaceId))
      .limit(1);
    return ws!;
  },
});

export const workspaceUpdateSettings = defineCommand({
  name: "workspace.update_settings",
  resource: "workspace",
  input: z.object({
    /** merge patch — currency etc. (e.g. { currency: "KRW" }) */
    settings: z.record(z.unknown()),
  }),
  permission: () => ({
    action: PermissionAction.Update,
    subject: SystemSubject.Settings,
  }),
  async execute(input, ctx) {
    const [current] = await ctx.db
      .select({ settings: workspaces.settings })
      .from(workspaces)
      .where(eq(workspaces.id, ctx.workspaceId))
      .limit(1);
    const merged = { ...(current?.settings ?? {}), ...input.settings };
    const [row] = await ctx.db
      .update(workspaces)
      .set({ settings: merged, updatedAt: new Date() })
      .where(eq(workspaces.id, ctx.workspaceId))
      .returning();
    return { id: row!.id, settings: row!.settings };
  },
  auditPayload: (i) => ({ keys: Object.keys(i.settings) }),
});
