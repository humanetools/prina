/**
 * One-time admin login route (IMPL-saas-cloud §3 ④) — Prina Cloud "Open admin".
 * Registered only when ONE_TIME_LOGIN_PUBLIC_KEY is set; absent (404) otherwise.
 *
 *   GET  /api/auth/one-time?token=…  → session cookie + 302 /admin (browser link)
 *   POST /api/auth/one-time {token}  → session cookie + { userId }  (programmatic)
 *
 * Failures answer 401 ONE_TIME_INVALID with a coarse reason class only (invalid /
 * expired / already used) — never which verification step failed.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { ActorType } from "@prina/shared";
import { auditLog, users } from "../../db/schema/index.js";
import type { Db } from "../../db/client.js";
import { createSession, pruneExpiredSessions } from "../../modules/auth/sessions.js";
import {
  OneTimeTokenError,
  verifyOneTimeToken,
  type OneTimeErrorReason,
} from "../../modules/auth/one-time.js";
import { setSessionCookie } from "../auth-hooks.js";

const REASON_MESSAGE: Record<OneTimeErrorReason, string> = {
  malformed: "Sign-in link is invalid",
  bad_signature: "Sign-in link is invalid",
  expired: "Sign-in link has expired",
  replayed: "Sign-in link was already used",
};

export interface OneTimeRouteOptions {
  publicKeyPem: string;
  sessionMaxAgeSec: number;
}

export function registerOneTimeLoginRoutes(
  app: FastifyInstance,
  db: Db,
  opts: OneTimeRouteOptions,
): void {
  /** Verify → user → session. Returns the user id or sends the error reply. */
  async function exchange(
    req: FastifyRequest,
    reply: FastifyReply,
    token: string | undefined,
  ): Promise<string | null> {
    if (typeof token !== "string" || token.length === 0) {
      return invalid(reply, "malformed");
    }
    let payload;
    try {
      payload = verifyOneTimeToken(token, opts.publicKeyPem);
    } catch (err) {
      if (err instanceof OneTimeTokenError) return invalid(reply, err.reason);
      throw err;
    }

    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.username, payload.username.trim().toLowerCase()))
      .limit(1);
    if (!user || !user.isActive || !user.isInstanceAdmin) {
      await reply.status(403).send({
        error: {
          code: "FORBIDDEN",
          message: "Sign-in link does not map to an instance admin",
          details: null,
        },
      });
      return null;
    }

    await pruneExpiredSessions(db);
    const session = await createSession(db, user.id);
    setSessionCookie(req, reply, session, opts.sessionMaxAgeSec);
    await db.insert(auditLog).values({
      workspaceId: null,
      actorType: ActorType.Human,
      actorId: user.id,
      actorLabel: user.name,
      action: "auth.login.one-time",
      resourceType: "session",
      payload: { tenant: payload.tenant, sub: payload.sub, jti: payload.jti },
    });
    return user.id;
  }

  app.get("/api/auth/one-time", async (req, reply) => {
    const { token } = req.query as { token?: string };
    const userId = await exchange(req, reply, token);
    if (userId === null) return reply;
    return reply.redirect("/admin", 302);
  });

  app.post("/api/auth/one-time", async (req, reply) => {
    const { token } = (req.body ?? {}) as { token?: string };
    const userId = await exchange(req, reply, token);
    if (userId === null) return reply;
    return { userId };
  });
}

async function invalid(reply: FastifyReply, reason: OneTimeErrorReason): Promise<null> {
  await reply.status(401).send({
    error: { code: "ONE_TIME_INVALID", message: REASON_MESSAGE[reason], details: null },
  });
  return null;
}
