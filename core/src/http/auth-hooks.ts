/**
 * HTTP auth hooks (T2.1)
 * ① Setup gate: while the wizard is incomplete, block all routes except /api/setup, /health, /admin (§3.4)
 * ② Session resolution: cookie (prina_session) or Authorization Bearer → req.prinaUser
 * ②' External API (IMPL-external-content-api → 20-IMPL-access-token-scopes): a management token
 *    (pmt_mgmt_*) opens the /api/* resource groups it was issued for (api-scopes.ts), at read or
 *    edit level — same role-bound credential the MCP management plane uses, so RBAC, audit, and
 *    workflow guards all apply through the command layer. The token pins the workspace
 *    (buildCommandCtx ignores the workspace header for token requests). Outside its scopes the
 *    answer is 403 SCOPE_DENIED (distinct from the role's 403 FORBIDDEN).
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
import { requiredScopeFor, scopeAllows } from "./api-scopes.js";
import { matchGrant, permissionsFromGrants, requiredGrantFor } from "./api-grants.js";

declare module "fastify" {
  interface FastifyRequest {
    prinaUser?: SessionUser;
    prinaActor?: Actor;
    /** Set when the request authenticated with a management token (external content API) */
    prinaApiToken?: VerifiedMcpToken;
  }
}

const API_TOKEN_PREFIX = "pmt_mgmt_";

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

    // ②' External API — management token, scoped per resource group (api-scopes.ts).
    // An invalid/revoked/delivery token falls through to the 401 below like an
    // unauthenticated request; a valid token outside its scopes gets 403 SCOPE_DENIED.
    if (!req.prinaUser && token?.startsWith(API_TOKEN_PREFIX) && url.startsWith("/api/")) {
      const apiToken = await verifyMcpToken(opts.db, token, McpPlane.Management);
      if (apiToken) {
        const deny = (message: string, details: Record<string, unknown>) =>
          reply.status(403).send({ error: { code: "SCOPE_DENIED", message, details } });
        if (apiToken.grants) {
          // custom mode: area ▸ item ▸ level (+type). The grants are also the token's permissions.
          const required = requiredGrantFor(req.method, url);
          const grant = required ? matchGrant(apiToken.grants, required) : null;
          if (!required || !grant) {
            const held = required ? apiToken.grants.find((g) => g.item === required.item) : undefined;
            return deny(
              required
                ? `This token has no '${required.item}' grant at '${required.level}' level${required.typeUid ? ` for type '${required.typeUid}'` : ""}`
                : "This path is not available to access tokens",
              required
                ? { item: required.item, required: required.level, typeUid: required.typeUid ?? null, granted: held ? { level: held.level, types: held.types ?? null } : null }
                : { item: null },
            );
          }
          req.prinaApiToken = apiToken;
          req.prinaActor = {
            type: ActorType.Ai,
            id: `api:${apiToken.name}`,
            label: apiToken.name,
            roleIds: [],
            permissions: permissionsFromGrants(apiToken.grants),
          };
        } else {
          // role mode: resource-group scopes gate the surface, the bound role decides inside
          const required = requiredScopeFor(req.method, url);
          if (!required || !scopeAllows(apiToken.scopes, required)) {
            return deny(
              required
                ? `This token lacks the '${required.scope}' scope at '${required.level}' level`
                : "This path is not available to access tokens",
              required
                ? { scope: required.scope, required: required.level, granted: apiToken.scopes[required.scope] ?? null }
                : { scope: null },
            );
          }
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
