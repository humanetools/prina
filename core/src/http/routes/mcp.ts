/**
 * MCP Streamable HTTP adapter (T6.1~T6.3)
 * - POST/GET/DELETE /mcp/management, /mcp/delivery — Bearer token (issued from the console)
 * - /mcp/<plane>/<workspace-slug> — the same server pinned to one workspace (48-IMPL). A token of another
 *   workspace is turned away with the OAuth hint for this address, so a client signs in for this workspace
 * - Session-based transport: tools/list_changed notification on type changes (T6.2)
 * - delivery plane: rate limit (60/min), CORS closed (server-to-server only — §2.6)
 */
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { DefaultRole, McpPlane, LEGACY_API_SCOPES } from "@prina/shared";
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { roles, workspaces } from "../../db/schema/index.js";
import type { Services } from "../../commands/context.js";
import { ConnectTokenError, isConnectToken, verifyConnectToken } from "../../modules/mcp/connect-token.js";
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

export interface McpRouteOptions {
  /**
   * ONE_TIME_LOGIN_PUBLIC_KEY — when set (Prina Cloud tenants), `pmt_ct_` connect tokens signed by
   * the control plane are accepted as bearers (19-IMPL-cloud-mcp §4). Absent on self-hosted instances.
   */
  connectPublicKey?: string;
}

export function registerMcpRoutes(
  app: FastifyInstance,
  db: Db,
  services: Services,
  opts: McpRouteOptions = {},
): void {
  const sessions = new Map<string, McpSession>();

  /**
   * Control-plane connect token → the shape of a console-issued token: primary workspace,
   * the workspace's Admin role for management, no locale scope for delivery. Nothing is written.
   */
  async function verifyConnectBearer(req: FastifyRequest, raw: string, plane: McpPlane, pinned: string | null): Promise<VerifiedMcpToken | null> {
    if (!opts.connectPublicKey) return null;
    const host = (req.headers["x-forwarded-host"] as string | undefined) ?? req.headers.host ?? "";
    let payload;
    try {
      payload = verifyConnectToken(raw, opts.connectPublicKey, { plane, host });
    } catch (e) {
      if (e instanceof ConnectTokenError) {
        req.log.warn({ reason: e.reason }, "mcp connect token rejected");
        return null;
      }
      throw e;
    }
    // The console speaks for the install's owner: the workspace in the address, else the primary one
    const [ws] = pinned
      ? [{ id: pinned }]
      : await db.select({ id: workspaces.id }).from(workspaces).orderBy(asc(workspaces.createdAt)).limit(1);
    if (!ws) return null;
    let roleId: string | null = null;
    if (plane === McpPlane.Management) {
      const [role] = await db
        .select({ id: roles.id })
        .from(roles)
        .where(and(eq(roles.workspaceId, ws.id), eq(roles.name, DefaultRole.Admin)))
        .limit(1);
      if (!role) return null;
      roleId = role.id;
    }
    // Connect tokens drive MCP only — REST scopes never apply; the legacy shape keeps the type honest
    return { id: `connect:${payload.jti}`, workspaceId: ws.id, plane, name: `cloud:${payload.client}`, roleId, localeScope: null, scopes: LEGACY_API_SCOPES, grants: null };
  }
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

  /** The workspace an address names, or null for the plain address; undefined when the slug is unknown */
  async function pinnedWorkspace(req: FastifyRequest): Promise<string | null | undefined> {
    const slug = (req.params as { ws?: string }).ws;
    if (!slug) return null;
    const [ws] = await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.slug, slug)).limit(1);
    return ws?.id;
  }

  async function authenticate(
    req: FastifyRequest,
    reply: FastifyReply,
    plane: McpPlane,
  ): Promise<VerifiedMcpToken | null> {
    const pinned = await pinnedWorkspace(req);
    if (pinned === undefined) {
      await reply.status(404).send({ jsonrpc: "2.0", error: { code: -32004, message: "No such workspace" }, id: null });
      return null;
    }
    const slug = (req.params as { ws?: string }).ws;
    const header = req.headers.authorization;
    const raw = header?.startsWith("Bearer ") ? header.slice(7) : null;
    let token = raw
      ? (isConnectToken(raw) ? await verifyConnectBearer(req, raw, plane, pinned) : await verifyMcpToken(db, raw, plane))
      : null;
    // A token is bound to one workspace — on a workspace address it must be that one
    if (token && pinned && token.workspaceId !== pinned) token = null;
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
          `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource/mcp/${plane}${slug ? `/${slug}` : ""}"`,
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

  const postHandler = async (req: FastifyRequest, reply: FastifyReply) => {
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
      // The address the client called, behind a proxy as the proxy saw it — a relative upload address
      // (local storage) is handed back prefixed with it
      const proto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim() ?? req.protocol;
      const host = (req.headers["x-forwarded-host"] as string | undefined)?.split(",")[0]?.trim() ?? req.headers.host;
      const { server } = await createMcpServer(db, services, token, { origin: host ? `${proto}://${host}` : undefined });
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
  };
  app.post("/mcp/:plane", postHandler);
  app.post("/mcp/:plane/:ws", postHandler);

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
  app.get("/mcp/:plane/:ws", streamHandler);
  app.delete("/mcp/:plane/:ws", streamHandler);
}
