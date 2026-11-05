/**
 * Workflow queries (T2.3) — reads live in core: OSS admin must also render the state chain and transitions.
 * Guard editing (workflowSetTransitionGuard) is EE (src/ee/workflow/commands.ts) — IMPL-ee-boundary.
 */
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { PermissionAction, SystemSubject } from "@prina/shared";
import { workflows, workflowTransitions } from "../../db/schema/index.js";
import { defineCommand } from "../../commands/define.js";
import { NotFoundError } from "../../lib/errors.js";
import type { CommandCtx } from "../../commands/context.js";

export async function getDefaultWorkflow(ctx: CommandCtx) {
  const [wf] = await ctx.db
    .select()
    .from(workflows)
    .where(and(eq(workflows.workspaceId, ctx.workspaceId), eq(workflows.isDefault, true)))
    .limit(1);
  if (!wf) throw new NotFoundError("No default workflow");
  return wf;
}

export const workflowGet = defineCommand({
  name: "workflow.get",
  resource: "workflow",
  skipAudit: true,
  input: z.object({}).default({}),
  permission: () => ({
    action: PermissionAction.Read,
    subject: SystemSubject.Workflows,
  }),
  async execute(_input, ctx) {
    const wf = await getDefaultWorkflow(ctx);
    const transitions = await ctx.db
      .select()
      .from(workflowTransitions)
      .where(eq(workflowTransitions.workflowId, wf.id));
    return { ...wf, transitions };
  },
});
