/**
 * Semantic search pipeline (T9.3) — pgvector gate + enqueue-on-publish + in-process worker.
 * [decision] pgvector is an optional capability: enabled when CREATE EXTENSION succeeds; if
 * not (not bundled / no privilege), only this feature silently turns off — existing FTS always
 * works (same principle as the BYOK air-gap fallback, §2.9). For the same reason,
 * entry_embeddings sits outside the drizzle migration chain (runtime IF NOT EXISTS) —
 * migrations must pass on installs without pgvector.
 */
import { sql } from "drizzle-orm";
import { EntryStatus } from "@prina/shared";
import type { Db } from "../../db/client.js";
import { embedTextsRouted, getEmbeddingSettings } from "../ai/routing.js";

let capability: boolean | null = null;

/**
 * Read-only capability check — **safe inside a caller's transaction**.
 * ensureVectorCapability's CREATE EXTENSION poisons the caller's tx with 25P02 on failure
 * (cascaded into the publish transition's audit write in CI — found 2026-08-14), so
 * in-transaction paths must use only this function. to_regclass is a SELECT that cannot fail.
 * Negative results are not cached — if the worker creates the table later, the next call revives.
 */
export async function vectorCapabilityReadOnly(db: Db): Promise<boolean> {
  if (capability === true) return true;
  try {
    const r = await db.execute(sql`SELECT to_regclass('entry_embeddings') AS t`);
    const present = (r.rows[0] as { t: unknown } | undefined)?.t !== null;
    if (present) capability = true;
    return present;
  } catch {
    return false;
  }
}

/** pgvector availability — tries extension/table creation once; on failure caches false forever.
 *  ⚠ Attempts DDL — call only outside transactions (worker/request db). Inside a tx use vectorCapabilityReadOnly. */
export async function ensureVectorCapability(db: Db): Promise<boolean> {
  if (capability !== null) return capability;
  try {
    await db.execute(sql`CREATE EXTENSION IF NOT EXISTS vector`);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS entry_embeddings (
        entry_id uuid PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE,
        workspace_id uuid NOT NULL,
        status text NOT NULL DEFAULT 'pending',
        model text,
        embedding vector,
        updated_at timestamptz NOT NULL DEFAULT now()
      )`);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS entry_embeddings_ws_status_idx
      ON entry_embeddings (workspace_id, status)`);
    capability = true;
  } catch {
    capability = false;
  }
  return capability;
}

/** For tests — reset the capability cache */
export function resetVectorCapability(): void {
  capability = null;
}

/**
 * Queue re-embedding on publish (or edit-while-published) — best-effort, safe even when
 * called inside the save transaction. No-op without the capability.
 */
export async function enqueueEmbedding(
  db: Db,
  entryId: string,
  workspaceId: string,
): Promise<void> {
  // Called inside save/transition transactions — no DDL, read-only check only
  if (!(await vectorCapabilityReadOnly(db))) return;
  try {
    await db.execute(sql`
      INSERT INTO entry_embeddings (entry_id, workspace_id, status)
      VALUES (${entryId}, ${workspaceId}, 'pending')
      ON CONFLICT (entry_id)
      DO UPDATE SET status = 'pending', updated_at = now()`);
  } catch {
    /* An embedding-queue failure must never block the save */
  }
}

export interface WorkerTickResult {
  processed: number;
  failed: number;
  skipped: "no-capability" | "no-settings" | null;
}

/** Process one pending batch — shared by the worker and tests */
export async function embedWorkerTick(db: Db, batchSize = 16): Promise<WorkerTickResult> {
  if (!(await ensureVectorCapability(db))) return { processed: 0, failed: 0, skipped: "no-capability" };
  const settings = await getEmbeddingSettings(db);
  if (!settings) return { processed: 0, failed: 0, skipped: "no-settings" };

  const rows = (
    await db.execute(sql`
      SELECT ee.entry_id, COALESCE(e.search_text, '') AS text
      FROM entry_embeddings ee
      JOIN entries e ON e.id = ee.entry_id AND e.status = ${EntryStatus.Published}
      WHERE ee.status = 'pending'
      ORDER BY ee.updated_at
      LIMIT ${batchSize}`)
  ).rows as Array<{ entry_id: string; text: string }>;
  if (rows.length === 0) return { processed: 0, failed: 0, skipped: null };

  try {
    const vectors = await embedTextsRouted(db, rows.map((r) => r.text || " "));
    for (let i = 0; i < rows.length; i++) {
      await db.execute(sql`
        UPDATE entry_embeddings
        SET embedding = ${JSON.stringify(vectors[i])}::vector,
            status = 'ready', model = ${settings.model}, updated_at = now()
        WHERE entry_id = ${rows[i]!.entry_id}`);
    }
    return { processed: rows.length, failed: 0, skipped: null };
  } catch {
    // Batch failed — mark as failed to stop infinite retries (republish resets to pending)
    for (const r of rows) {
      await db.execute(sql`
        UPDATE entry_embeddings SET status = 'failed', updated_at = now()
        WHERE entry_id = ${r.entry_id} AND status = 'pending'`);
    }
    return { processed: 0, failed: rows.length, skipped: null };
  }
}

/** In-process embedding worker — each tick no-ops without capability/settings (fewer parts: queue = DB) */
export function startEmbeddingWorker(db: Db, intervalMs = 15_000): () => void {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await embedWorkerTick(db);
    } catch {
      /* A failed tick retries on the next tick */
    } finally {
      running = false;
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

export interface VectorHit {
  id: string;
  typeUid: string;
  typeName: string;
  locale: string;
  title: unknown;
  snippet: string | null;
  distance: number;
}

/** Cosine top-k over published entries by query vector (exact scan — no index needed at self-hosted scale) */
export async function vectorSearch(
  db: Db,
  workspaceId: string,
  queryEmbedding: number[],
  opts: { typeUid?: string; locale?: string; limit?: number } = {},
): Promise<VectorHit[]> {
  const limit = Math.min(opts.limit ?? 20, 50);
  const result = await db.execute(sql`
    SELECT e.id,
           ct.uid AS type_uid,
           ct.name AS type_name,
           e.locale,
           e.values ->> COALESCE(ct.definition ->> 'displayField', 'title') AS title,
           LEFT(e.search_text, 200) AS snippet,
           ee.embedding <=> ${JSON.stringify(queryEmbedding)}::vector AS distance
    FROM entry_embeddings ee
    JOIN entries e ON e.id = ee.entry_id
    JOIN content_types ct ON ct.id = e.content_type_id
    WHERE ee.workspace_id = ${workspaceId}
      AND ee.status = 'ready'
      AND e.status = ${EntryStatus.Published}
      AND e.parent_entry_id IS NULL
      ${opts.typeUid ? sql`AND ct.uid = ${opts.typeUid}` : sql``}
      ${opts.locale ? sql`AND e.locale = ${opts.locale}` : sql``}
    ORDER BY distance
    LIMIT ${limit}`);
  return (result.rows as Record<string, unknown>[]).map((r) => ({
    id: String(r.id),
    typeUid: String(r.type_uid),
    typeName: String(r.type_name),
    locale: String(r.locale),
    title: r.title,
    snippet: r.snippet === null ? null : String(r.snippet),
    distance: Number(r.distance),
  }));
}
