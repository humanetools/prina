/** Version snapshot recording (T1.5) — called on entry save/transition. Viewing/restore is EE (src/ee/versions) */
import { desc, eq } from "drizzle-orm";
import { contentVersions } from "../../db/schema/index.js";
import type { EntrySnapshot } from "../../db/schema/index.js";
import { shallowDiff } from "../../lib/diff.js";
import type { CommandCtx } from "../../commands/context.js";
import type { EntryRow } from "./variants.js";

export async function recordVersion(ctx: CommandCtx, entry: EntryRow): Promise<number> {
  const [latest] = await ctx.db
    .select()
    .from(contentVersions)
    .where(eq(contentVersions.entryId, entry.id))
    .orderBy(desc(contentVersions.version))
    .limit(1);

  const snapshot: EntrySnapshot = {
    values: entry.values,
    status: entry.status,
    locale: entry.locale,
    variantValues: entry.variantValues ?? null,
    seo: entry.seo ?? null,
  };
  const nextVersion = (latest?.version ?? 0) + 1;
  const diff = latest
    ? shallowDiff(
        {
          ...latest.snapshot.values,
          __status: latest.snapshot.status,
          __seo: latest.snapshot.seo ?? null,
        },
        { ...snapshot.values, __status: snapshot.status, __seo: snapshot.seo ?? null },
      )
    : null;

  await ctx.db.insert(contentVersions).values({
    workspaceId: ctx.workspaceId,
    entryId: entry.id,
    version: nextVersion,
    snapshot,
    diff,
    actorType: ctx.actor.type,
    actorId: ctx.actor.id ?? null,
  });
  return nextVersion;
}
