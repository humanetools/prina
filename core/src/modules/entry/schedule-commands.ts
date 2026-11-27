/**
 * Scheduled publishing (54-IMPL) — "publish this entry at a moment" and "take it down at a moment".
 *
 * A schedule is a promise to run the ordinary transition later, with the rights of the person who set it:
 * the permission check, the transition guard, required fields and strict SEO checks all apply at run time
 * exactly as if that person pressed the button then. A run that is refused is kept as `failed` with the
 * reason, and shows on the entry — nothing is skipped silently.
 */
import { z } from "zod";
import { and, desc, eq, inArray, lte, sql } from "drizzle-orm";
import { ActorType, EntryStatus, PermissionAction, contentSubject } from "@prina/shared";
import { entrySchedules, users } from "../../db/schema/index.js";
import type { Db } from "../../db/client.js";
import { defineCommand } from "../../commands/define.js";
import type { CommandCtx, Services } from "../../commands/context.js";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { getContentTypeByUid } from "../content-type/repo.js";
import { getEntryScoped } from "./save-helpers.js";
import { entryTransition } from "./transition-commands.js";

export type ScheduleAction = "publish" | "unpublish";
export type ScheduleRow = typeof entrySchedules.$inferSelect;

/** The state an action moves the entry to */
export const targetState = (action: ScheduleAction): EntryStatus =>
  action === "publish" ? EntryStatus.Published : EntryStatus.Draft;

/** A schedule further away than this is almost certainly a typo in the year */
const MAX_AHEAD_MS = 3 * 366 * 86_400_000;

const view = (row: ScheduleRow) => ({
  id: row.id,
  entryId: row.entryId,
  typeUid: row.typeUid,
  action: row.action as ScheduleAction,
  runAt: row.runAt,
  status: row.status,
  scheduledByLabel: row.scheduledByLabel,
  createdAt: row.createdAt,
  executedAt: row.executedAt,
  error: row.error,
});

/** Same right the transition itself needs: publish to publish, transition to take down */
const transitionPermission = (i: { typeUid: string; action: ScheduleAction }) => ({
  action: i.action === "publish" ? PermissionAction.Publish : PermissionAction.Transition,
  subject: contentSubject(i.typeUid),
});

/** Sets (or replaces) the pending schedule of one action for an entry */
export const entryScheduleSet = defineCommand({
  name: "entry.schedule",
  resource: "entry",
  input: z.object({
    typeUid: z.string().min(1),
    entryId: z.string().uuid(),
    action: z.enum(["publish", "unpublish"]),
    /** ISO date-time */
    runAt: z.string().datetime({ offset: true }),
  }),
  permission: (i) => transitionPermission(i),
  async execute(input, ctx) {
    if (ctx.actor.type !== ActorType.Human || !ctx.actor.id) {
      throw new ValidationError("A schedule runs with the rights of the person who sets it — sign in to schedule");
    }
    const runAt = new Date(input.runAt);
    const now = Date.now();
    if (runAt.getTime() <= now) throw new ValidationError("Choose a moment in the future");
    if (runAt.getTime() > now + MAX_AHEAD_MS) throw new ValidationError("That is more than three years away");

    const contentType = await getContentTypeByUid(ctx.db, ctx.workspaceId, input.typeUid);
    const entry = await getEntryScoped(ctx, contentType, input.entryId);

    // one pending schedule per action — setting it again replaces it
    await ctx.db
      .update(entrySchedules)
      .set({ status: "cancelled", executedAt: new Date() })
      .where(and(eq(entrySchedules.entryId, entry.id), eq(entrySchedules.action, input.action), eq(entrySchedules.status, "pending")));
    const [row] = await ctx.db
      .insert(entrySchedules)
      .values({
        workspaceId: ctx.workspaceId,
        entryId: entry.id,
        typeUid: input.typeUid,
        action: input.action,
        runAt,
        scheduledBy: ctx.actor.id,
        scheduledByLabel: ctx.actor.label ?? null,
      })
      .returning();
    return view(row!);
  },
  resourceId: (i) => i.entryId,
  auditPayload: (i) => ({ typeUid: i.typeUid, action: i.action, runAt: i.runAt }),
});

export const entryScheduleCancel = defineCommand({
  name: "entry.unschedule",
  resource: "entry",
  input: z.object({ id: z.string().uuid() }),
  async execute(input, ctx) {
    const [row] = await ctx.db
      .select()
      .from(entrySchedules)
      .where(and(eq(entrySchedules.workspaceId, ctx.workspaceId), eq(entrySchedules.id, input.id)))
      .limit(1);
    if (!row) throw new NotFoundError("Schedule not found");
    // cancelling needs the same right as setting it
    await ctx.services.authorize(
      { name: "entry.unschedule", resource: "entry", permission: transitionPermission({ typeUid: row.typeUid, action: row.action as ScheduleAction }) },
      input,
      ctx,
    );
    if (row.status !== "pending") throw new ValidationError("Only a waiting schedule can be cancelled");
    const [updated] = await ctx.db
      .update(entrySchedules)
      .set({ status: "cancelled", executedAt: new Date() })
      .where(and(eq(entrySchedules.id, row.id), eq(entrySchedules.status, "pending")))
      .returning();
    if (!updated) throw new ValidationError("This schedule has just run");
    return view(updated);
  },
  resourceId: (_i, o) => o.entryId,
  auditPayload: (_i, o) => ({ typeUid: o.typeUid, action: o.action, runAt: o.runAt }),
});

/** Waiting schedules of an entry plus its last few outcomes */
export const entryScheduleList = defineCommand({
  name: "entry.schedules",
  resource: "entry",
  skipAudit: true,
  input: z.object({ typeUid: z.string().min(1), entryId: z.string().uuid() }),
  permission: (i) => ({ action: PermissionAction.Read, subject: contentSubject(i.typeUid) }),
  async execute(input, ctx) {
    const rows = await ctx.db
      .select()
      .from(entrySchedules)
      .where(
        and(
          eq(entrySchedules.workspaceId, ctx.workspaceId),
          eq(entrySchedules.entryId, input.entryId),
          inArray(entrySchedules.status, ["pending", "running", "done", "failed"]),
        ),
      )
      .orderBy(desc(entrySchedules.createdAt))
      .limit(20);
    const waiting = rows.filter((r) => r.status === "pending" || r.status === "running").sort((a, b) => a.runAt.getTime() - b.runAt.getTime());
    // the latest outcome per action is what the entry screen needs — not the whole history
    const recent = rows.filter((r) => r.status === "done" || r.status === "failed").slice(0, 3);
    return { waiting: waiting.map(view), recent: recent.map(view) };
  },
});

// ── Running ─────────────────────────────────────────────────────

/** The context a run uses: the person who scheduled it — null when that account is gone or switched off */
export async function ctxForUser(db: Db, services: Services, workspaceId: string, userId: string | null): Promise<CommandCtx | null> {
  if (!userId) return null;
  const [u] = await db.select({ id: users.id, username: users.username, name: users.name, isActive: users.isActive }).from(users).where(eq(users.id, userId)).limit(1);
  if (!u || !u.isActive) return null;
  return { db, workspaceId, services, actor: { type: ActorType.Human, id: u.id, label: u.name || u.username } };
}

export const reasonOf = (e: unknown): string => {
  const base = e instanceof Error ? e.message : String(e);
  // "required fields are incomplete" is only useful with the fields named
  const missing = (e as { details?: { missing?: Array<{ field?: string; label?: string }> } } | null)?.details?.missing;
  const names = Array.isArray(missing) ? missing.map((m) => m.label || m.field).filter(Boolean) : [];
  return (names.length ? `${base}: ${names.join(", ")}` : base).slice(0, 500);
};

/**
 * Runs every schedule that is due. Returns how many it ran. Tests drive this directly and pass their own
 * workspace, so parallel test files sharing a database do not run each other's schedules.
 */
export async function scheduleWorkerTick(db: Db, services: Services, now = new Date(), onlyWorkspaceId?: string): Promise<number> {
  // claim first — a second instance must not run the same schedule
  const due = await db
    .update(entrySchedules)
    .set({ status: "running" })
    .where(
      and(
        eq(entrySchedules.status, "pending"),
        lte(entrySchedules.runAt, now),
        ...(onlyWorkspaceId ? [eq(entrySchedules.workspaceId, onlyWorkspaceId)] : []),
      ),
    )
    .returning();
  for (const row of due.sort((a, b) => a.runAt.getTime() - b.runAt.getTime())) {
    let error: string | null = null;
    try {
      const ctx = await ctxForUser(db, services, row.workspaceId, row.scheduledBy);
      if (!ctx) throw new Error("The person who scheduled this no longer has an active account");
      await entryTransition.run({ typeUid: row.typeUid, id: row.entryId, to: targetState(row.action as ScheduleAction) }, ctx);
    } catch (e) {
      // already where the schedule wanted it (published by hand in the meantime, or a run cut short by a restart)
      if (!(e instanceof ValidationError && e.message.startsWith("Already in"))) error = reasonOf(e);
    }
    await db
      .update(entrySchedules)
      .set({ status: error ? "failed" : "done", error, executedAt: new Date() })
      .where(eq(entrySchedules.id, row.id));
  }
  return due.length;
}

/** A run interrupted by a restart is put back in the queue (a transition that already happened then fails as "Already in …") */
export async function requeueInterruptedSchedules(db: Db): Promise<void> {
  await db.execute(sql`UPDATE entry_schedules SET status = 'pending' WHERE status = 'running'`);
}

export function startScheduleWorker(db: Db, services: Services, intervalMs = 30_000): () => void {
  let running = false;
  void requeueInterruptedSchedules(db).catch(() => {});
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await scheduleWorkerTick(db, services);
    } catch {
      /* a failed tick retries on the next one */
    } finally {
      running = false;
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
