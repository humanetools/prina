/** Common entry-save procedure — shared by create/update/restore (junction of T1.4~1.8) */
import { and, eq } from "drizzle-orm";
import { ContentTypeKind, EntryStatus } from "@prina/shared";
import { entries, locales } from "../../db/schema/index.js";
import { NotFoundError } from "../../lib/errors.js";
import type { CommandCtx } from "../../commands/context.js";
import type { ContentTypeRow } from "../content-type/repo.js";
import { buildSearchText, validateEntryValues } from "./validate.js";
import {
  assertExclusiveRelations,
  assertNoSelfReference,
  assertUniqueValues,
  deriveUidValues,
} from "./unique.js";
import { computeCompleteness } from "./completeness.js";
import { resolveEffectiveValues, syncVariantChildren, type EntryRow } from "./variants.js";
import { syncEntryRelations } from "./relations.js";
import { syncAssetUsages } from "./asset-usages.js";
import { recordVersion } from "./versions.js";
import { enqueueEmbedding } from "../delivery/semantic.js";
import { emitEntryEvent } from "../../commands/context.js";

export async function defaultLocale(ctx: CommandCtx): Promise<string> {
  const [row] = await ctx.db
    .select({ code: locales.code })
    .from(locales)
    .where(and(eq(locales.workspaceId, ctx.workspaceId), eq(locales.isDefault, true)))
    .limit(1);
  return row?.code ?? "ko";
}

export async function getEntryScoped(
  ctx: CommandCtx,
  contentType: ContentTypeRow,
  id: string,
): Promise<EntryRow> {
  const [row] = await ctx.db
    .select()
    .from(entries)
    .where(
      and(
        eq(entries.workspaceId, ctx.workspaceId),
        eq(entries.contentTypeId, contentType.id),
        eq(entries.id, id),
      ),
    )
    .limit(1);
  if (!row) throw new NotFoundError(`Entry ${id} not found`);
  return row;
}

export async function loadParent(ctx: CommandCtx, entry: EntryRow): Promise<EntryRow | null> {
  if (!entry.parentEntryId) return null;
  const [row] = await ctx.db
    .select()
    .from(entries)
    .where(eq(entries.id, entry.parentEntryId))
    .limit(1);
  return row ?? null;
}

export interface SavedEntry {
  entry: EntryRow;
  version: number;
  variants: { created: number; removed: number; kept: number };
}

/**
 * Saves an entry row whose values are finalized, with validation and derived-data computation.
 * Steps: validate values → search_text & completeness → UPDATE → version snapshot → sync variants & relations
 */
export async function persistEntryValues(
  ctx: CommandCtx,
  contentType: ContentTypeRow,
  entry: EntryRow,
  rawValues: Record<string, unknown>,
): Promise<SavedEntry> {
  const nextValues = await deriveUidValues(ctx, contentType, entry, rawValues);
  await validateEntryValues(ctx, contentType, nextValues);
  assertNoSelfReference(contentType, entry, nextValues);
  await assertUniqueValues(ctx, contentType, entry, nextValues);
  await assertExclusiveRelations(ctx, contentType, entry, nextValues);

  const parent = await loadParent(ctx, entry);
  const effective = resolveEffectiveValues(
    contentType.definition,
    { ...entry, values: nextValues },
    parent,
  );
  const completeness = computeCompleteness(
    ctx.services.registry,
    contentType.definition,
    effective,
  );
  const searchText = buildSearchText(ctx, contentType.definition, effective);

  const [updated] = await ctx.db
    .update(entries)
    .set({
      values: nextValues,
      searchText,
      completeness: { score: completeness.score },
      // A saved entry is a reviewed entry — clear AI-draft provenance (IMPL-ai-locale-translation)
      aiDraft: null,
      updatedBy: ctx.actor.id && ctx.actor.type === "human" ? ctx.actor.id : null,
      updatedAt: new Date(),
    })
    .where(eq(entries.id, entry.id))
    .returning();

  const version = await recordVersion(ctx, updated!);
  const variants = await syncVariantChildren(ctx, contentType.definition, updated!);
  await syncEntryRelations(ctx, contentType.definition, updated!);
  await syncAssetUsages(ctx, contentType.definition, updated!); // T4.3
  // If content changes while published, re-enqueue semantic embedding (T9.3, no-op without pgvector)
  if (updated!.status === EntryStatus.Published) {
    await enqueueEmbedding(ctx.db, updated!.id, ctx.workspaceId);
    // Entry lifecycle fan-out (EE chatbot knowledge, C0) — errors are logged, never thrown
    await emitEntryEvent(ctx, {
      kind: "updated",
      entryId: updated!.id,
      workspaceId: ctx.workspaceId,
      typeUid: contentType.uid,
      locale: updated!.locale,
    });
  }
  return { entry: updated!, version, variants };
}

export function assertKindAllowsCreate(
  contentType: ContentTypeRow,
  existingCount: number,
): boolean {
  return !(contentType.kind === ContentTypeKind.Single && existingCount > 0);
}
