/**
 * Session management (T2.1)
 * [decision] No library — Lucia-style pattern implemented directly (Lucia itself is deprecated,
 * only its pattern docs remain valid). Opaque token + stored sha256 hash + sliding expiry.
 */
import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, lt } from "drizzle-orm";
import { sessions, users } from "../../db/schema/index.js";
import type { Db } from "../../db/client.js";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const RENEW_THRESHOLD_MS = 15 * 24 * 60 * 60 * 1000; // renew when under 15 days remain

export type SessionUser = typeof users.$inferSelect;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSession(db: Db, userId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await db.insert(sessions).values({
    userId,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  });
  return token;
}

export async function validateSession(
  db: Db,
  token: string,
): Promise<SessionUser | null> {
  const tokenHash = hashToken(token);
  const [row] = await db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, new Date())))
    .limit(1);
  if (!row || !row.user.isActive) return null;

  // Sliding expiry
  if (row.session.expiresAt.getTime() - Date.now() < RENEW_THRESHOLD_MS) {
    await db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() + SESSION_TTL_MS) })
      .where(eq(sessions.id, row.session.id));
  }
  return row.user;
}

export async function destroySession(db: Db, token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
}

/** Prune expired sessions — called opportunistically on login */
export async function pruneExpiredSessions(db: Db): Promise<void> {
  await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
}
