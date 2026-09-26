/**
 * MCP server factory (T6.1/T6.2/T6.3) — one session per token, Streamable HTTP.
 * Sends tools/list_changed notifications to active management sessions on type changes.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { eq } from "drizzle-orm";
import { ZodError } from "zod";
import { ActorType, McpPlane } from "@prina/shared";
import { workspaces } from "../db/schema/index.js";
import type { Db } from "../db/client.js";
import type { CommandCtx, Services } from "../commands/context.js";
import { AppError } from "../lib/errors.js";
import { resolveWorkspace } from "../modules/delivery/service.js";
import type { VerifiedMcpToken } from "../modules/mcp/tokens.js";
import { buildDeliveryTools, buildManagementTools, type ToolSet } from "./tools.js";
import { CORE_VERSION } from "../version.js";

export async function createMcpServer(
  db: Db,
  services: Services,
  token: VerifiedMcpToken,
): Promise<{ server: Server; workspaceId: string }> {
  const server = new Server(
    { name: `prina-${token.plane}`, version: CORE_VERSION },
    { capabilities: { tools: { listChanged: true } } },
  );

  const buildToolSet = async (): Promise<ToolSet> => {
    if (token.plane === McpPlane.Management) {
      const ctx: CommandCtx = {
        db,
        workspaceId: token.workspaceId,
        actor: {
          type: ActorType.Ai,
          id: `mcp:${token.name}`,
          label: token.name,
          roleIds: token.roleId ? [token.roleId] : [],
        },
        services,
      };
      return buildManagementTools(db, services, ctx);
    }
    const [ws] = await db
      .select({ slug: workspaces.slug })
      .from(workspaces)
      .where(eq(workspaces.id, token.workspaceId))
      .limit(1);
    const workspace = await resolveWorkspace(db, ws!.slug);
    return buildDeliveryTools(db, services, workspace, token.localeScope);
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const { tools } = await buildToolSet();
    return { tools };
  });

  /**
   * Tool errors are the only diagnosis an agent (or the user reading its transcript) gets —
   * a bare "Internal error" makes a failure unresolvable from the client side. Always answer
   * with a structured {error:{code,message,details}} so the model can correct itself, and
   * carry the real message for unexpected failures too (stack traces stay server-side).
   */
  const toolError = (code: string, message: string, details?: unknown) => ({
    content: [
      { type: "text" as const, text: JSON.stringify({ error: { code, message, details: details ?? null } }, null, 2) },
    ],
    isError: true,
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { tools, handlers } = await buildToolSet();
    const handler = handlers.get(req.params.name);
    if (!handler) {
      return toolError("UNKNOWN_TOOL", `Unknown tool: ${req.params.name}`, {
        availableTools: tools.map((t) => t.name),
      });
    }
    try {
      const result = await handler((req.params.arguments ?? {}) as Record<string, unknown>);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (e) {
      // Includes permission/guard denials — denials are already recorded in the audit log by the command pipeline (T6.2 DoD)
      if (e instanceof AppError) {
        return toolError(e.code, e.message, e.details ?? null);
      }
      if (e instanceof ZodError) {
        return toolError("VALIDATION_ERROR", "Arguments are not valid", {
          issues: e.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
        });
      }
      const message = e instanceof Error ? e.message : String(e);
      return toolError("INTERNAL", message);
    }
  });

  return { server, workspaceId: token.workspaceId };
}
