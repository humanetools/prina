/**
 * MCP Streamable HTTP adapter (T6.1~T6.3)
 * - POST/GET/DELETE /mcp/management, /mcp/delivery — Bearer token (issued from the console)
 * - Session-based transport: tools/list_changed notification on type changes (T6.2)
 * - delivery plane: rate limit (60/min), CORS closed (server-to-server only — §2.6)
 */
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { McpPlane } from "@prina/shared";
import type { Db } from "../../db/client.js";
import type { Services } from "../../commands/context.js";
import { verifyMcpToken, type VerifiedMcpToken } from "../../modules/mcp/tokens.js";
import { createMcpServer } from "../../mcp/server.js";

interface McpSession {
  transport: StreamableHTTPServerTransport;
  server: Server;
  workspaceId: string;
  plane: McpPlane;
  tokenId: string;
}

const RATE_LIMIT_PER_MIN = 60;

export function registerMcpRoutes(
  app: FastifyInstance,
  db: Db,
  services: Services,
): void {
  const sessions = new Map<string, McpSession>();
  const rateBuckets = new Map<string, { windowStart: number; count: number }>();

  // Type change → listChanged to that workspace's management sessions (T6.2)
  services.events.on("content-types-changed", (workspaceId: string) => {
    for (const s of sessions.values()) {
      if (s.plane === McpPlane.Management && s.workspaceId === workspaceId) {
        void s.server
          .notification({ method: "notifications/tools/list_changed" })
          .catch(() => {});
      }
    }
  });

  function rateLimited(tokenId: string): boolean {
    const now = Date.now();
    const bucket = rateBuckets.get(tokenId);
    if (!bucket || now - bucket.windowStart > 60_000) {
      rateBuckets.set(tokenId, { windowStart: now, count: 1 });
      return false;
    }
    bucket.count += 1;
    return bucket.count > RATE_LIMIT_PER_MIN;
  }

  async function authenticate(
    req: FastifyRequest,
    reply: FastifyReply,
    plane: McpPlane,
  ): Promise<VerifiedMcpToken | null> {
    const header = req.headers.authorization;
    const raw = header?.startsWith("Bearer ") ? header.slice(7) : null;
    const token = raw ? await verifyMcpToken(db, raw, plane) : null;
    if (!token) {
      // RFC 9728 — hint for OAuth clients to locate protected resource metadata
      const proto =
        (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim() ??
        req.protocol;
      const issuer = `${proto}://${(req.headers["x-forwarded-host"] as string | undefined) ?? req.headers.host}`;
      await reply
        .status(401)
        .header(
          "www-authenticate",
          `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource/mcp/${plane}"`,
        )
        .send({
          jsonrpc: "2.0",
          error: { code: -32001, message: "A valid MCP token is required (Bearer)" },
          id: null,
        });
      return null;
    }
    if (plane === McpPlane.Delivery && rateLimited(token.id)) {
      await reply.status(429).send({
        jsonrpc: "2.0",
        error: { code: -32002, message: "Rate limit exceeded (60 per minute)" },
        id: null,
      });
      return null;
    }
    return token;
  }

  function planeOf(req: FastifyRequest): McpPlane | null {
    const { plane } = req.params as { plane: string };
    if (plane === McpPlane.Management || plane === McpPlane.Delivery) return plane;
    return null;
  }

  app.post("/mcp/:plane", async (req, reply) => {
    const plane = planeOf(req);
    if (!plane) return reply.status(404).send();
    const token = await authenticate(req, reply, plane);
    if (!token) return;

    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let session = sessionId ? sessions.get(sessionId) : undefined;
    // Sessions are bound to the issuing token — block reuse of another token's session
    if (session && session.tokenId !== token.id) session = undefined;

    if (!session) {
      if (!isInitializeRequest(req.body)) {
        // Sessions live in memory, so every restart invalidates the id the client holds.
        // The spec makes 404 the signal to start a new session — with anything else the
        // client treats it as a hard failure and the connector stays dead until a human
        // reconnects it. A request with no session id at all is a different mistake (400).
        const status = sessionId ? 404 : 400;
        return reply.status(status).send({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: sessionId
              ? "Session not found or expired — send initialize to start a new one"
              : "No session — send initialize first",
          },
          id: null,
        });
      }
      const { server } = await createMcpServer(db, services, token);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          sessions.set(sid, {
            transport,
            server,
            workspaceId: token.workspaceId,
            plane,
            tokenId: token.id,
          });
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      await server.connect(transport);
      reply.hijack();
      await transport.handleRequest(req.raw, reply.raw, req.body);
      return;
    }

    reply.hijack();
    await session.transport.handleRequest(req.raw, reply.raw, req.body);
  });

  const streamHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    const plane = planeOf(req);
    if (!plane) return reply.status(404).send();
    const token = await authenticate(req, reply, plane);
    if (!token) return;
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (!session || session.tokenId !== token.id) {
      return reply.status(404).send({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Session not found" },
        id: null,
      });
    }
    reply.hijack();
    await session.transport.handleRequest(req.raw, reply.raw);
  };
  app.get("/mcp/:plane", streamHandler);
  app.delete("/mcp/:plane", streamHandler);
}
