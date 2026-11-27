/**
 * OAuth 2.1 adapter (§2.6) — the standard access path for remote MCP clients such as claude.ai.
 * Discovery (.well-known) → DCR → consent screen (admin session) → code+PKCE → mcp_tokens issuance.
 * The actual logic lives in modules/mcp/oauth.ts.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, asc, eq } from "drizzle-orm";
import { McpPlane } from "@prina/shared";
import { roles, userRoles, workspaces } from "../../db/schema/index.js";
import type { Db } from "../../db/client.js";

/**
 * The workspace an authorization is for (48-IMPL): the one named by the MCP address the client is
 * connecting to (`resource` = …/mcp/<plane>/<slug>), else the primary (oldest) workspace.
 * null when the address names a workspace that does not exist.
 */
async function workspaceFor(db: Db, slug: string | null): Promise<{ id: string; slug: string; name: string } | null> {
  if (slug) {
    const [row] = await db.select({ id: workspaces.id, slug: workspaces.slug, name: workspaces.name }).from(workspaces).where(eq(workspaces.slug, slug)).limit(1);
    return row ?? null;
  }
  const [row] = await db.select({ id: workspaces.id, slug: workspaces.slug, name: workspaces.name }).from(workspaces).orderBy(asc(workspaces.createdAt)).limit(1);
  return row ?? null;
}

/** …/mcp/management/brand-korea → "brand-korea" */
function slugFromResource(resource: string | undefined): string | null {
  const m = resource ? /\/mcp\/(?:management|delivery)\/([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\/?(?:[?#].*)?$/.exec(resource) : null;
  return m?.[1] ?? null;
}

/** Signed-in person may act on the workspace: instance admin, or holds a role in it */
async function mayUseWorkspace(db: Db, user: { id: string; isInstanceAdmin: boolean }, workspaceId: string): Promise<boolean> {
  if (user.isInstanceAdmin) return true;
  const [row] = await db.select({ id: userRoles.userId }).from(userRoles).where(and(eq(userRoles.userId, user.id), eq(userRoles.workspaceId, workspaceId))).limit(1);
  return !!row;
}

import {
  createAuthCode,
  exchangeCode,
  getClient,
  registerClient,
} from "../../modules/mcp/oauth.js";

function issuerOf(req: FastifyRequest): string {
  const proto =
    (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim() ??
    req.protocol;
  const host = (req.headers["x-forwarded-host"] as string | undefined) ?? req.headers.host;
  return `${proto}://${host}`;
}

import { consentBody, shell, signInBody } from "./oauth-pages.js";

/** Host the client actually reached — shown on the screens and used in the footer */
const hostOf = (req: FastifyRequest): string =>
  (req.headers["x-forwarded-host"] as string | undefined) ?? req.headers.host ?? "";

export function registerOAuthRoutes(app: FastifyInstance, db: Db): void {
  // Form-encoding parser — used by OAuth token/consent requests (registered instance-wide)
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_req, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(body as string)));
    },
  );

  const asDoc = (req: FastifyRequest) => {
    const issuer = issuerOf(req);
    return {
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: [McpPlane.Management, McpPlane.Delivery],
    };
  };
  app.get("/.well-known/oauth-authorization-server", async (req) => asDoc(req));
  app.get("/.well-known/oauth-authorization-server/*", async (req) => asDoc(req));

  const prDoc = (req: FastifyRequest, plane?: string, ws?: string) => {
    const issuer = issuerOf(req);
    return {
      resource: plane ? `${issuer}/mcp/${plane}${ws ? `/${ws}` : ""}` : issuer,
      authorization_servers: [issuer],
      bearer_methods_supported: ["header"],
    };
  };
  app.get("/.well-known/oauth-protected-resource", async (req) => prDoc(req));
  app.get("/.well-known/oauth-protected-resource/mcp/:plane", async (req) =>
    prDoc(req, (req.params as { plane: string }).plane),
  );
  app.get("/.well-known/oauth-protected-resource/mcp/:plane/:ws", async (req) => {
    const p = req.params as { plane: string; ws: string };
    return prDoc(req, p.plane, p.ws);
  });

  app.post("/oauth/register", async (req, reply) => {
    const result = await registerClient(db, (req.body ?? {}) as Record<string, unknown>);
    return reply.status("error" in result ? 400 : 201).send(result);
  });

  app.get("/oauth/authorize", async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const client = q.client_id ? await getClient(db, q.client_id) : null;
    const redirectOk = !!client && !!q.redirect_uri && client.redirectUris.includes(q.redirect_uri);
    if (!client || !redirectOk) {
      return reply.status(400).type("text/html").send(
        shell({
          title: "Invalid request",
          host: hostOf(req),
          body: `<div class="body"><div class="head"><h1>Invalid authorization request</h1>
            <div class="desc">Unknown client or redirect URI. The client must register first (RFC 7591).</div>
          </div></div>`,
        }),
      );
    }
    const back = (error: string) =>
      reply.redirect(
        `${q.redirect_uri}?error=${error}${q.state ? `&state=${encodeURIComponent(q.state)}` : ""}`,
      );
    if (q.response_type !== "code") return back("unsupported_response_type");
    if (!q.code_challenge || (q.code_challenge_method ?? "S256") !== "S256") {
      return back("invalid_request");
    }

    // Browser not logged in — log in on the same screen, then reload
    if (!req.prinaUser) {
      return reply.type("text/html").send(
        shell({ title: "Sign in", host: hostOf(req), body: signInBody(client.name) }),
      );
    }

    // Consent screen — plane selection (+ role if management), for the workspace the address names
    const pinnedSlug = slugFromResource(q.resource);
    const ws = await workspaceFor(db, pinnedSlug);
    const deny = (title: string, text: string) =>
      reply.status(403).type("text/html").send(
        shell({ title, host: hostOf(req), body: `<div class="body"><div class="head"><h1>${title}</h1><div class="desc">${text}</div></div></div>` }),
      );
    if (!ws) return deny("Unknown workspace", "The address names a workspace that does not exist on this Prina instance.");
    if (!(await mayUseWorkspace(db, req.prinaUser, ws.id))) {
      return deny("No access to this workspace", "Your account has no role in this workspace. Ask an administrator to give you one, or sign in with another account.");
    }
    const workspaceId = ws.id;
    const roleRows = await db
      .select({ id: roles.id, name: roles.name })
      .from(roles)
      .where(eq(roles.workspaceId, workspaceId))
      .orderBy(asc(roles.name));
    const defaultPlane = q.resource?.includes("/mcp/delivery")
      ? McpPlane.Delivery
      : McpPlane.Management;
    return reply.type("text/html").send(
      shell({
        title: "Authorize",
        host: hostOf(req),
        body: consentBody({
          clientName: client.name,
          host: hostOf(req),
          username: req.prinaUser.username,
          userName: req.prinaUser.name,
          redirectUri: q.redirect_uri!,
          roles: roleRows,
          defaultPlane,
          workspace: pinnedSlug ? { name: ws.name, slug: ws.slug } : null,
          hidden: {
            workspace: pinnedSlug ?? "",
            client_id: client.id,
            redirect_uri: q.redirect_uri,
            code_challenge: q.code_challenge,
            state: q.state,
          },
        }),
      }),
    );
  });

  app.post("/oauth/authorize", async (req, reply) => {
    if (!req.prinaUser) return reply.status(401).send({ error: "access_denied" });
    const b = (req.body ?? {}) as Record<string, string | undefined>;
    const client = b.client_id ? await getClient(db, b.client_id) : null;
    if (!client || !b.redirect_uri || !client.redirectUris.includes(b.redirect_uri)) {
      return reply.status(400).send({ error: "invalid_request" });
    }
    const suffix = b.state ? `&state=${encodeURIComponent(b.state)}` : "";
    if (b.decision !== "approve") {
      return reply.redirect(`${b.redirect_uri}?error=access_denied${suffix}`);
    }
    if (!b.code_challenge) return reply.redirect(`${b.redirect_uri}?error=invalid_request${suffix}`);
    const plane = b.plane === McpPlane.Delivery ? McpPlane.Delivery : McpPlane.Management;
    const ws = await workspaceFor(db, b.workspace || null);
    if (!ws || !(await mayUseWorkspace(db, req.prinaUser, ws.id))) {
      return reply.redirect(`${b.redirect_uri}?error=access_denied${suffix}`);
    }
    const workspaceId = ws.id;
    // The chosen role must be one of this workspace's roles
    if (plane === McpPlane.Management && b.role_id) {
      const [role] = await db.select({ id: roles.id }).from(roles).where(and(eq(roles.id, b.role_id), eq(roles.workspaceId, workspaceId))).limit(1);
      if (!role) return reply.redirect(`${b.redirect_uri}?error=invalid_request${suffix}`);
    }
    const code = await createAuthCode(db, {
      clientId: client.id,
      redirectUri: b.redirect_uri,
      codeChallenge: b.code_challenge,
      userId: req.prinaUser.id,
      workspaceId,
      plane,
      roleId: plane === McpPlane.Management ? (b.role_id || null) : null,
    });
    return reply.redirect(`${b.redirect_uri}?code=${encodeURIComponent(code)}${suffix}`);
  });

  app.post("/oauth/token", async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, string | undefined>;
    if (b.grant_type !== "authorization_code") {
      return reply.status(400).send({
        error: "unsupported_grant_type",
        error_description: "Only authorization_code is supported",
      });
    }
    if (!b.code || !b.client_id || !b.code_verifier) {
      return reply.status(400).send({
        error: "invalid_request",
        error_description: "code, client_id and code_verifier are required",
      });
    }
    const result = await exchangeCode(db, {
      code: b.code,
      clientId: b.client_id,
      redirectUri: b.redirect_uri,
      codeVerifier: b.code_verifier,
    });
    if ("error" in result) return reply.status(400).send(result);
    return reply.send(result);
  });
}
