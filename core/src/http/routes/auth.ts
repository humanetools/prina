/** Auth routes (T2.1) — login/logout/me */
import type { FastifyInstance } from "fastify";
import { asc, eq, inArray } from "drizzle-orm";
import { ActorType } from "@prina/shared";
import { auditLog, userRoles, users, workspaces } from "../../db/schema/index.js";
import type { Db } from "../../db/client.js";
import { verifyPassword } from "../../modules/auth/passwords.js";
import { createLoginThrottle } from "../../modules/auth/login-throttle.js";
import {
  createSession,
  destroySession,
  pruneExpiredSessions,
} from "../../modules/auth/sessions.js";
import {
  clearSessionCookie,
  extractToken,
  setSessionCookie,
} from "../auth-hooks.js";
import type { Services } from "../../commands/context.js";
import { buildIdentityCtx } from "../request-context.js";
import { registerOneTimeLoginRoutes } from "./auth-one-time.js";
import {
  passwordChange,
  profileGet,
  profileUpdate,
} from "../../modules/auth/profile-commands.js";

const SESSION_MAX_AGE_SEC = 30 * 24 * 60 * 60;

export interface AuthRouteOptions {
  /** ONE_TIME_LOGIN_PUBLIC_KEY — enables /api/auth/one-time (IMPL-saas-cloud §3 ④) */
  oneTimeLoginPublicKey?: string;
}

export function registerAuthRoutes(
  app: FastifyInstance,
  db: Db,
  services: Services,
  opts: AuthRouteOptions = {},
): void {
  const throttle = createLoginThrottle();

  if (opts.oneTimeLoginPublicKey) {
    registerOneTimeLoginRoutes(app, db, {
      publicKeyPem: opts.oneTimeLoginPublicKey,
      sessionMaxAgeSec: SESSION_MAX_AGE_SEC,
    });
  }

  app.post("/api/auth/login", async (req, reply) => {
    const body = req.body as { username?: string; password?: string };
    if (!body?.username || !body?.password) {
      return reply.status(422).send({
        error: { code: "VALIDATION_ERROR", message: "username and password are required", details: null },
      });
    }
    // Sign-in is internet-reachable once a public address is claimed (the OAuth screen
    // posts here), so repeated guesses get locked out per username+IP
    const throttleKey = `${body.username.trim().toLowerCase()}|${req.ip}`;
    const verdict = throttle.check(throttleKey);
    if (verdict.retryAfter > 0) {
      return reply
        .status(429)
        .header("retry-after", String(verdict.retryAfter))
        .send({
          error: {
            code: "TOO_MANY_ATTEMPTS",
            message: `Too many sign-in attempts — try again in ${verdict.retryAfter}s`,
            details: null,
          },
        });
    }
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.username, body.username.trim().toLowerCase()))
      .limit(1);
    const ok =
      user?.passwordHash && user.isActive
        ? await verifyPassword(body.password, user.passwordHash)
        : false;
    if (!ok || !user) {
      throttle.recordFailure(throttleKey);
      return reply.status(401).send({
        error: {
          code: "INVALID_CREDENTIALS",
          message: "ID or password is incorrect",
          details: null,
        },
      });
    }
    throttle.recordSuccess(throttleKey);

    await pruneExpiredSessions(db);
    const token = await createSession(db, user.id);
    setSessionCookie(req, reply, token, SESSION_MAX_AGE_SEC);
    await db.insert(auditLog).values({
      workspaceId: null,
      actorType: ActorType.Human,
      actorId: user.id,
      actorLabel: user.name,
      action: "auth.login",
      resourceType: "session",
    });
    const { passwordHash: _ph, ...safe } = user;
    return { user: safe, token };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    const token = extractToken(req);
    if (token) await destroySession(db, token);
    clearSessionCookie(req, reply);
    return { ok: true };
  });

  app.get("/api/auth/me", async (req, reply) => {
    if (!req.prinaUser) {
      return reply.status(401).send({
        error: { code: "UNAUTHORIZED", message: "Sign in required", details: null },
      });
    }
    const memberships = await db
      .select({ workspaceId: userRoles.workspaceId, roleId: userRoles.roleId })
      .from(userRoles)
      .where(eq(userRoles.userId, req.prinaUser.id));
    const { passwordHash: _ph, ...safe } = req.prinaUser;
    return { user: safe, memberships };
  });

  // ── My Account ────────────────────────────────────────────────
  app.get("/api/auth/profile", async (req) =>
    profileGet.run({}, await buildIdentityCtx(req, db, services)),
  );

  app.put("/api/auth/profile", async (req) =>
    profileUpdate.run(req.body, await buildIdentityCtx(req, db, services)),
  );

  app.post("/api/auth/password", async (req, reply) => {
    const ctx = await buildIdentityCtx(req, db, services);
    const result = await passwordChange.run(req.body, ctx);
    // The command invalidated all sessions, so reissue a session for the current device
    const token = await createSession(db, result.id);
    setSessionCookie(req, reply, token, SESSION_MAX_AGE_SEC);
    return { ok: true, token };
  });

  /**
   * List of accessible workspaces — for the workspace switcher (T3.1).
   * An identity-scoped query needed before a workspace is determined, so it sits at the same level as /me.
   */
  app.get("/api/workspaces", async (req, reply) => {
    if (!req.prinaUser) {
      return reply.status(401).send({
        error: { code: "UNAUTHORIZED", message: "Sign in required", details: null },
      });
    }
    if (req.prinaUser.isInstanceAdmin) {
      return db.select().from(workspaces).orderBy(asc(workspaces.slug));
    }
    const memberships = await db
      .select({ workspaceId: userRoles.workspaceId })
      .from(userRoles)
      .where(eq(userRoles.userId, req.prinaUser.id));
    const ids = [...new Set(memberships.map((m) => m.workspaceId))];
    if (ids.length === 0) return [];
    return db
      .select()
      .from(workspaces)
      .where(inArray(workspaces.id, ids))
      .orderBy(asc(workspaces.slug));
  });
}
