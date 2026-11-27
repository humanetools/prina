/** MCP console tool viewer command (T6.4) — lists auto-generated tools and their schemas */
import { z } from "zod";
import { eq } from "drizzle-orm";
import { McpPlane, PermissionAction, SystemSubject } from "@prina/shared";
import { workspaces } from "../../db/schema/index.js";
import { defineCommand } from "../../commands/define.js";
import { buildDeliveryTools, buildManagementTools } from "../../mcp/tools.js";
import { resolveWorkspace } from "../delivery/service.js";

export const mcpToolsList = defineCommand({
  name: "mcp.tools_list",
  resource: "mcp_tools",
  skipAudit: true,
  input: z.object({ plane: z.nativeEnum(McpPlane) }),
  permission: () => ({
    action: PermissionAction.Read,
    subject: SystemSubject.McpConsole,
  }),
  async execute(input, ctx) {
    if (input.plane === McpPlane.Management) {
      const { tools } = await buildManagementTools(ctx.db, ctx.services, ctx);
      return tools;
    }
    const [ws] = await ctx.db
      .select({ slug: workspaces.slug })
      .from(workspaces)
      .where(eq(workspaces.id, ctx.workspaceId))
      .limit(1);
    const workspace = await resolveWorkspace(ctx.db, ws!.slug);
    const { tools } = await buildDeliveryTools(ctx.db, ctx.services, workspace, null);
    return tools;
  },
});
