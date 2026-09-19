/** MCP console admin API (T6.4) — token issuance/revocation and tool viewer (command calls only) */
import type { FastifyInstance } from "fastify";
import type { Db } from "../../db/client.js";
import type { Services } from "../../commands/context.js";
import { buildCommandCtx } from "../request-context.js";
import {
  mcpTokenCreate,
  mcpTokenList,
  mcpTokenRevoke,
} from "../../modules/mcp/tokens.js";
import { mcpToolsList } from "../../modules/mcp/console.js";

export function registerMcpConsoleRoutes(
  app: FastifyInstance,
  db: Db,
  services: Services,
): void {
  const ctx = (req: Parameters<typeof buildCommandCtx>[0]) =>
    buildCommandCtx(req, db, services);

  app.get("/api/mcp/tokens", async (req) => mcpTokenList.run({}, await ctx(req)));
  app.post("/api/mcp/tokens", async (req, reply) =>
    reply.status(201).send(await mcpTokenCreate.run(req.body, await ctx(req))),
  );
  app.delete("/api/mcp/tokens/:id", async (req) => {
    const { id } = req.params as { id: string };
    return mcpTokenRevoke.run({ id }, await ctx(req));
  });
  app.get("/api/mcp/tools", async (req) =>
    mcpToolsList.run(req.query, await ctx(req)),
  );
}
