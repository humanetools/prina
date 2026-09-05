/**
 * Cross-type search (T6.3 + T9.3) — FTS+pg_trgm always; semantic (pgvector+BYOK) fused via
 * RRF (reciprocal rank fusion) when available. On embedding-call failure, silently returns FTS only.
 */
import { sql } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { embedTextsRouted, getEmbeddingSettings } from "../ai/routing.js";
import { ensureVectorCapability, vectorSearch } from "./semantic.js";

export interface SearchHit {
  id: string;
  typeUid: string;
  typeName: string;
  locale: string;
  title: unknown;
  snippet: string | null;
  rank: number;
  /** Which path matched — fts | semantic | both (always fts when semantic is off) */
  matchedBy?: "fts" | "semantic" | "both";
}

export async function searchPublished(
  db: Db,
  workspaceId: string,
  query: string,
  opts: { typeUid?: string; locale?: string; limit?: number } = {},
): Promise<SearchHit[]> {
  // Normalize once at the entry point: the MCP plane's typeof-number check lets NaN and
  // negatives through, and downstream Math.min(limit, 50) would hand them straight to LIMIT
  opts = { ...opts, limit: Number.isFinite(opts.limit) ? Math.max(1, Math.floor(opts.limit!)) : undefined };
  const ftsHits = await ftsSearch(db, workspaceId, query, opts);
  const fused = await trySemanticFuse(db, workspaceId, query, opts, ftsHits);
  return fused ?? ftsHits.map((h) => ({ ...h, matchedBy: "fts" as const }));
}

async function ftsSearch(
  db: Db,
  workspaceId: string,
  query: string,
  opts: { typeUid?: string; locale?: string; limit?: number } = {},
): Promise<SearchHit[]> {
  const limit = Math.min(opts.limit ?? 20, 50);
  const result = await db.execute(sql`
    SELECT e.id,
           ct.uid AS type_uid,
           ct.name AS type_name,
           e.locale,
           e.values ->> COALESCE(ct.definition ->> 'displayField', 'title') AS title,
           LEFT(e.search_text, 200) AS snippet,
           GREATEST(
             ts_rank(to_tsvector('simple', COALESCE(e.search_text, '')),
                     plainto_tsquery('simple', ${query})),
             similarity(COALESCE(e.search_text, ''), ${query})
           ) AS rank
    FROM entries e
    JOIN content_types ct ON ct.id = e.content_type_id
    WHERE e.workspace_id = ${workspaceId}
      AND e.status = 'published'
      AND e.parent_entry_id IS NULL
      AND (
        to_tsvector('simple', COALESCE(e.search_text, '')) @@ plainto_tsquery('simple', ${query})
        OR COALESCE(e.search_text, '') % ${query}
        OR e.search_text ILIKE '%' || ${query} || '%'
      )
      ${opts.typeUid ? sql`AND ct.uid = ${opts.typeUid}` : sql``}
      ${opts.locale ? sql`AND e.locale = ${opts.locale}` : sql``}
    ORDER BY rank DESC
    LIMIT ${limit}
  `);
  return (result.rows as Record<string, unknown>[]).map((r) => ({
    id: String(r.id),
    typeUid: String(r.type_uid),
    typeName: String(r.type_name),
    locale: String(r.locale),
    title: r.title,
    snippet: r.snippet === null ? null : String(r.snippet),
    rank: Number(r.rank),
  }));
}

const RRF_K = 60;

/** Semantic fusion — null when capability/settings missing or the embedding call fails (caller falls back to FTS) */
async function trySemanticFuse(
  db: Db,
  workspaceId: string,
  query: string,
  opts: { typeUid?: string; locale?: string; limit?: number },
  ftsHits: SearchHit[],
): Promise<SearchHit[] | null> {
  if (!(await ensureVectorCapability(db))) return null;
  const settings = await getEmbeddingSettings(db);
  if (!settings) return null;
  try {
    const [queryVec] = await embedTextsRouted(db, [query]);
    const vecHits = await vectorSearch(db, workspaceId, queryVec!, opts);
    if (vecHits.length === 0 && ftsHits.length === 0) return [];

    const limit = Math.min(opts.limit ?? 20, 50);
    const fused = new Map<string, SearchHit & { score: number }>();
    ftsHits.forEach((h, i) => {
      fused.set(h.id, { ...h, matchedBy: "fts", score: 1 / (RRF_K + i + 1) });
    });
    vecHits.forEach((v, i) => {
      const score = 1 / (RRF_K + i + 1);
      const prev = fused.get(v.id);
      if (prev) {
        prev.score += score;
        prev.matchedBy = "both";
      } else {
        fused.set(v.id, {
          id: v.id, typeUid: v.typeUid, typeName: v.typeName, locale: v.locale,
          title: v.title, snippet: v.snippet, rank: 0, matchedBy: "semantic", score,
        });
      }
    });
    return [...fused.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ score, ...hit }) => ({ ...hit, rank: score }));
  } catch {
    return null; // embedding provider outage — search itself continues via FTS
  }
}
