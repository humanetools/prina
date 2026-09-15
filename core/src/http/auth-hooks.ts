/**
 * HTTP auth hooks (T2.1)
 * ① Setup gate: while the wizard is incomplete, block all routes except /api/setup, /health, /admin (§3.4)
 * ② Session resolution: cookie (prina_session) or Authorization Bearer → req.prinaUser
 * ②' External content API (IMPL-external-content-api): a management token (pmt_mgmt_*) opens
 *    /api/content/* only — same role-bound credential the MCP management plane uses, so RBAC,
 *    audit, and workflow guards all apply through the command layer. The token pins the
 *    workspace (buildCommandCtx ignores the workspace header for token requests).
 * ③ Protection: /api/* requires a session (x-prina-actor header fallback allowed only in dev/test environments)
 * Cookie parsing is implemented directly — no external plugin adopted (minimize moving parts).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { withColdStartRetry, type Db } from "../db/client.js";
import { getSetupState } from "../modules/setup/service.js";
import { validateSession, type SessionUser } from "../modules/auth/sessions.js";
import { verifyMcpToken, type VerifiedMcpToken } from "../modules/mcp/tokens.js";
import { parseActor } from "./request-context.js";
import type { Actor } from "../commands/context.js";
import { ActorType, McpPlane } from "@prina/shared";

declare module "fastify" {
  interface FastifyRequest {
    prinaUser?: SessionUser;
    prinaActor?: Actor;
    /** Set when the request authenticated with a management token (external content API) */
    prinaApiToken?: VerifiedMcpToken;
  }
}

/** Paths a management token may reach over REST — deliberately narrower than a session */
const API_TOKEN_PREFIX = "pmt_mgmt_";
const API_TOKEN_ALLOWED_PATH = "/api/content/";

export const SESSION_COOKIE = "prina_session";

export function readCookie(req: FastifyRequest, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

export function extractToken(req: FastifyRequest): string | undefined {
  const bearer = req.headers.authorization;
  if (bearer?.startsWith("Bearer ")) return bearer.slice(7);
  return readCookie(req, SESSION_COOKIE);
}

/**
 * `Secure` is decided per request, not by NODE_ENV: on-prem kits are served over plain
 * HTTP (http://localhost:3000) where a Secure cookie would never be sent back, while a
 * hosted instance sits behind a TLS-terminating proxy. Fastify's `req.protocol` reads
 * `x-forwarded-proto` only when the app was built with trustProxy (TRUST_PROXY=true), so
 * a client on a directly exposed host cannot spoof the scheme.
 */
export function isSecureRequest(req: FastifyRequest): boolean {
  return req.protocol === "https";
}

export function setSessionCookie(
  req: FastifyRequest,
  reply: FastifyReply,
  token: string,
  maxAgeSec: number,
): void {
  reply.header(
    "set-cookie",
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${
      isSecureRequest(req) ? "; Secure" : ""
    }`,
  );
}

export function clearSessionCookie(req: FastifyRequest, reply: FastifyReply): void {
  reply.header(
    "set-cookie",
    `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${
      isSecureRequest(req) ? "; Secure" : ""
    }`,
  );
}

interface HookOptions {
  db: Db;
  isProduction: boolean;
}

const SETUP_CACHE_TTL_MS = 5_000;
let setupCache: { completed: boolean; at: number } | null = null;

/** Used by tests that need setup-state changes reflected immediately */
export function invalidateSetupCache(): void {
  setupCache = null;
}

export function registerAuthHooks(app: FastifyInstance, opts: HookOptions): void {
  app.addHook("onRequest", async (req, reply) => {
    const url = req.url;

    // ① Setup gate — first DB touch of a request: retried once so a suspended
    // (serverless) Postgres waking up does not surface as a 500 to the first caller
    if (!setupCache || Date.now() - setupCache.at > SETUP_CACHE_TTL_MS) {
      const state = await withColdStartRetry(() => getSetupState(opts.db));
      setupCache = { completed: state.completed, at: Date.now() };
    }
    const isSetupExempt =
      url === "/health" ||
      url.startsWith("/api/setup") ||
      url.startsWith("/admin") ||
      url === "/favicon.ico";
    if (!setupCache.completed && !isSetupExempt) {
      return reply.status(409).send({
        error: {
          code: "SETUP_REQUIRED",
          message: "Complete the setup wizard first (/admin)",
          details: null,
        },
      });
    }

    // ② Session resolution
    const token = extractToken(req);
    if (token && !token.startsWith(API_TOKEN_PREFIX)) {
      const user = await withColdStartRetry(() => validateSession(opts.db, token));
      if (user) {
        req.prinaUser = user;
        req.prinaActor = { type: ActorType.Human, id: user.id, label: user.name };
      }
    }

    // ②' External content API — management token, /api/content/* only.
    // Outside the allowlist (or with a delivery/revoked token) the request falls
    // through to the 401 below, same as an unauthenticated one.
    if (
      !req.prinaUser &&
      token?.startsWith(API_TOKEN_PREFIX) &&
      url.startsWith(API_TOKEN_ALLOWED_PATH)
    ) {
      const apiToken = await verifyMcpToken(opts.db, token, McpPlane.Management);
      if (apiToken) {
        req.prinaApiToken = apiToken;
        // `api:` (not `mcp:`) so the audit log tells the REST surface apart from MCP
        req.prinaActor = {
          type: ActorType.Ai,
          id: `api:${apiToken.name}`,
          label: apiToken.name,
          roleIds: apiToken.roleId ? [apiToken.roleId] : [],
        };
      }
    }

    // ③ API protection
    // /api/auth/one-time carries its own credential (a signed token); it stays behind
    // the setup gate above — a tenant is always set up before a link is issued
    const needsAuth =
      url.startsWith("/api/") &&
      !url.startsWith("/api/auth/login") &&
      !url.startsWith("/api/auth/one-time") &&
      !url.startsWith("/api/setup");
    if (needsAuth && !req.prinaUser && !req.prinaApiToken) {
      // Dev/test convenience: allow specifying the actor header without a session (forbidden in production)
      const devHeader = req.headers["x-prina-actor"] as string | undefined;
      if (!opts.isProduction && devHeader) {
        req.prinaActor = parseActor(devHeader);
        return;
      }
      return reply.status(401).send({
        error: { code: "UNAUTHORIZED", message: "Sign in required", details: null },
      });
    }
  });
}
