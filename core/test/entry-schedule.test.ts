/** 54-IMPL — scheduled publish / unpublish of one entry: set, replace, cancel, and what the worker does when it is due */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { EntryStatus } from "@prina/shared";
import { entries, entrySchedules, users } from "../src/db/schema/index.js";
import { contentTypeCreate } from "../src/modules/content-type/commands.js";
import { entryCreate, entryUpdate } from "../src/modules/entry/commands.js";
import { entryTransition } from "../src/modules/entry/transition-commands.js";
import {
  entryScheduleCancel,
  entryScheduleList,
  entryScheduleSet,
  requeueInterruptedSchedules,
  scheduleWorkerTick,
} from "../src/modules/entry/schedule-commands.js";
import type { CommandCtx } from "../src/commands/context.js";
import { publishEntry, setupTestContext, type TestContext } from "./helpers.js";
import { articleDefinition } from "./fixtures.js";

let t: TestContext;
const inMinutes = (n: number) => new Date(Date.now() + n * 60_000).toISOString();
const later = () => new Date(Date.now() + 3_600_000);

/** A saved entry one step away from published — draft in the core workflow, approved in the 4-stage one */
async function readyEntry(title: string, ctx: CommandCtx = t.ctx): Promise<string> {
  const { entry } = await entryCreate.run({ typeUid: "article", values: { title } }, ctx);
  for (const to of [EntryStatus.Review, EntryStatus.Approved]) {
    await entryTransition.run({ typeUid: "article", id: entry.id, to }, t.ctx).catch(() => {});
  }
  return entry.id;
}
const statusOf = async (id: string) => (await t.db.select({ s: entries.status }).from(entries).where(eq(entries.id, id)))[0]!.s;
const schedule = (entryId: string, action: "publish" | "unpublish", runAt = inMinutes(30), ctx: CommandCtx = t.ctx) =>
  entryScheduleSet.run({ typeUid: "article", entryId, action, runAt }, ctx);
const listed = (entryId: string) => entryScheduleList.run({ typeUid: "article", entryId }, t.ctx);

beforeAll(async () => {
  t = await setupTestContext();
  await contentTypeCreate.run({ uid: "article", name: "Article", definition: articleDefinition }, t.ctx);
});
afterAll(async () => t.cleanup());
// the worker runs everything that is due — a schedule left waiting by one test must not fire in the next
afterEach(async () => {
  await t.db.update(entrySchedules).set({ status: "cancelled" }).where(and(eq(entrySchedules.status, "pending"), eq(entrySchedules.workspaceId, t.workspaceId)));
});

describe("setting a schedule", () => {
  it("keeps one waiting schedule per action — setting it again replaces it, the other action stays", async () => {
    const id = await readyEntry("Launch");
    await schedule(id, "publish", inMinutes(30));
    const second = await schedule(id, "publish", inMinutes(90));
    await schedule(id, "unpublish", inMinutes(600));
    const { waiting } = await listed(id);
    expect(waiting.map((w) => w.action)).toEqual(["publish", "unpublish"]); // soonest first
    expect(waiting[0]!.id).toBe(second.id);
  });

  it("refuses a moment that is not in the future, or absurdly far away", async () => {
    const id = await readyEntry("When");
    await expect(schedule(id, "publish", inMinutes(-1))).rejects.toThrow(/in the future/);
    await expect(schedule(id, "publish", new Date(Date.now() + 4 * 366 * 86_400_000).toISOString())).rejects.toThrow(/three years/);
    await expect(entryScheduleSet.run({ typeUid: "article", entryId: id, action: "publish", runAt: "tomorrow" }, t.ctx)).rejects.toThrow();
  });

  it("needs the right the transition itself needs", async () => {
    const id = await readyEntry("Rights");
    const nobody = await t.createUserCtx([]);
    await expect(schedule(id, "publish", inMinutes(30), nobody.ctx)).rejects.toThrow(/Not allowed/);
    const mine = await schedule(id, "publish");
    await expect(entryScheduleCancel.run({ id: mine.id }, nobody.ctx)).rejects.toThrow(/Not allowed/);
  });

  it("can be cancelled while it waits, and only then", async () => {
    const id = await readyEntry("Cancel");
    const s = await schedule(id, "publish");
    await entryScheduleCancel.run({ id: s.id }, t.ctx);
    expect((await listed(id)).waiting).toEqual([]);
    await expect(entryScheduleCancel.run({ id: s.id }, t.ctx)).rejects.toThrow(/Only a waiting schedule/);
    expect(await scheduleWorkerTick(t.db, t.services, later(), t.workspaceId)).toBe(0);
    expect(await statusOf(id)).not.toBe("published");
  });
});

describe("the worker", () => {
  it("runs what is due and leaves the rest waiting", async () => {
    const due = await readyEntry("Due");
    const notYet = await readyEntry("Not yet");
    await schedule(due, "publish", inMinutes(10));
    await schedule(notYet, "publish", inMinutes(300));
    expect(await scheduleWorkerTick(t.db, t.services, new Date(Date.now() + 20 * 60_000), t.workspaceId)).toBe(1);
    expect(await statusOf(due)).toBe("published");
    expect(await statusOf(notYet)).not.toBe("published");
    const { waiting, recent } = await listed(due);
    expect(waiting).toEqual([]);
    expect(recent[0]).toMatchObject({ action: "publish", status: "done", error: null });
    await entryScheduleCancel.run({ id: (await listed(notYet)).waiting[0]!.id }, t.ctx);
  });

  it("takes a published entry down at its moment", async () => {
    const { entry } = await entryCreate.run({ typeUid: "article", values: { title: "Campaign" } }, t.ctx);
    await publishEntry(t.ctx, "article", entry.id);
    await schedule(entry.id, "unpublish", inMinutes(5));
    await scheduleWorkerTick(t.db, t.services, later(), t.workspaceId);
    expect(await statusOf(entry.id)).toBe("draft");
  });

  it("keeps the reason when the transition is refused — required fields are checked at run time", async () => {
    const id = await readyEntry("Will break");
    await schedule(id, "publish", inMinutes(5));
    // the title is required; it is emptied after the schedule was set
    await t.db.update(entries).set({ values: {} }).where(eq(entries.id, id));
    await scheduleWorkerTick(t.db, t.services, later(), t.workspaceId);
    expect(await statusOf(id)).not.toBe("published");
    const { recent } = await listed(id);
    expect(recent[0]!.status).toBe("failed");
    expect(recent[0]!.error).toMatch(/required fields are incomplete.*title/);
  });

  it("fails when the person who scheduled it no longer has an active account", async () => {
    const publisher = await t.createUserCtx(["admin"]);
    const id = await readyEntry("Orphan");
    await schedule(id, "publish", inMinutes(5), publisher.ctx);
    await t.db.update(users).set({ isActive: false }).where(eq(users.id, publisher.userId));
    await scheduleWorkerTick(t.db, t.services, later(), t.workspaceId);
    expect(await statusOf(id)).not.toBe("published");
    expect((await listed(id)).recent[0]!.error).toMatch(/no longer has an active account/);
  });

  it("counts an entry that is already where the schedule wanted it as done", async () => {
    const id = await readyEntry("By hand");
    await schedule(id, "publish", inMinutes(5));
    await entryTransition.run({ typeUid: "article", id, to: EntryStatus.Published }, t.ctx);
    await scheduleWorkerTick(t.db, t.services, later(), t.workspaceId);
    expect((await listed(id)).recent[0]).toMatchObject({ status: "done", error: null });
  });

  it("puts a run cut short by a restart back in the queue", async () => {
    const id = await readyEntry("Interrupted");
    const s = await schedule(id, "publish", inMinutes(5));
    await t.db.update(entrySchedules).set({ status: "running" }).where(eq(entrySchedules.id, s.id));
    expect(await scheduleWorkerTick(t.db, t.services, later(), t.workspaceId)).toBe(0);
    await requeueInterruptedSchedules(t.db);
    expect(await scheduleWorkerTick(t.db, t.services, later(), t.workspaceId)).toBe(1);
    expect(await statusOf(id)).toBe("published");
  });

  it("an edit after scheduling does not cancel it", async () => {
    const id = await readyEntry("Edited");
    await schedule(id, "unpublish", inMinutes(500));
    await entryUpdate.run({ typeUid: "article", id, values: { title: "Edited again" } }, t.ctx).catch(() => {});
    expect((await listed(id)).waiting).toHaveLength(1);
    await entryScheduleCancel.run({ id: (await listed(id)).waiting[0]!.id }, t.ctx);
  });
});
