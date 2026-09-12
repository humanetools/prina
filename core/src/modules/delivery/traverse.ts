/**
 * T9.2 multi-hop graph traversal — recursive CTE over entry_relations.
 * Two modes: path (field-name chain, e.g. ["series","brand"]) / depth (expand all relations N hops).
 * Cycles blocked via the visited array; publishedOnly walks published entries only.
 * If performance falls short, this is the Apache AGE switch-over point (SPEC §2.7).
 */
import { sql } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { NotFoundError } from "../../lib/errors.js";

export const TRAVERSE_MAX_DEPTH = 5;
/** Runaway guard — edge count cap (overflow is trimmed and truncated=true) */
export const TRAVERSE_MAX_EDGES = 1000;

export interface TraverseEdge {
  from: string;
  to: string;
  field: string;
  predicate: string | null;
  depth: number;
}

export interface TraverseNode {
  id: string;
  documentId: string;
  typeUid: string;
  typeName: string;
  schemaOrgType: string | null;
  locale: string;
  status: string;
  display: unknown;
}

export interface TraverseResult {
  start: string;
  mode: "path" | "depth";
  depth: number;
  nodes: TraverseNode[];
  edges: TraverseEdge[];
  /** path mode: entry ids that reached the chain end (depth == path.length) */
  targets: string[];
  truncated: boolean;
}

export interface TraverseOpts {
  startId: string;
  /** relation field-name chain — presence selects path mode */
  path?: string[];
  /** expansion depth when no path is given (default 1) */
  depth?: number;
  publishedOnly: boolean;
}

export async function traverseGraph(
  db: Db,
  workspaceId: string,
  opts: TraverseOpts,
): Promise<TraverseResult> {
  const path = opts.path && opts.path.length > 0 ? opts.path : null;
  const maxDepth = Math.min(path ? path.length : (opts.depth ?? 1), TRAVERSE_MAX_DEPTH);

  // Validate the start entry (workspace scope + publishedOnly)
  const startRes = await db.execute(sql`
    SELECT e.id, e.status FROM entries e
    WHERE e.id = ${opts.startId} AND e.workspace_id = ${workspaceId}
  `);
  const startRow = (startRes.rows as Record<string, unknown>[])[0];
  if (!startRow || (opts.publishedOnly && startRow.status !== "published")) {
    throw new NotFoundError(`Entry '${opts.startId}' not found`);
  }

  const publishedCond = opts.publishedOnly ? sql`AND te.status = 'published'` : sql``;
  // drizzle sql templates expand JS arrays into ($1,$2) records — bind arrays as one value via sql.param
  const pathParam = () => (path ? sql.param(path) : sql`NULL`);
  const result = await db.execute(sql`
    WITH RECURSIVE walk (from_id, to_id, field, predicate, depth, visited) AS (
      SELECT er.from_entry_id, er.to_entry_id, er.field, er.predicate, 1,
             ARRAY[er.from_entry_id, er.to_entry_id]
      FROM entry_relations er
      JOIN entries te ON te.id = er.to_entry_id
      WHERE er.workspace_id = ${workspaceId}
        AND er.from_entry_id = ${opts.startId}
        AND (${pathParam()}::text[] IS NULL OR er.field = (${pathParam()}::text[])[1])
        ${publishedCond}
      UNION ALL
      SELECT er.from_entry_id, er.to_entry_id, er.field, er.predicate, w.depth + 1,
             w.visited || er.to_entry_id
      FROM walk w
      JOIN entry_relations er ON er.from_entry_id = w.to_id
      JOIN entries te ON te.id = er.to_entry_id
      WHERE w.depth < ${maxDepth}
        AND er.workspace_id = ${workspaceId}
        AND er.to_entry_id <> ALL(w.visited)
        AND (${pathParam()}::text[] IS NULL OR er.field = (${pathParam()}::text[])[w.depth + 1])
        ${publishedCond}
    )
    SELECT from_id, to_id, field, predicate, depth FROM walk
    ORDER BY depth
    LIMIT ${TRAVERSE_MAX_EDGES + 1}
  `);

  const rawEdges = result.rows as Record<string, unknown>[];
  const truncated = rawEdges.length > TRAVERSE_MAX_EDGES;
  // A node reached via multiple routes has its expansion repeated per route —
  // dedupe on (from, field, to); ORDER BY depth keeps the minimum depth
  const seen = new Set<string>();
  const edges: TraverseEdge[] = [];
  for (const r of rawEdges.slice(0, TRAVERSE_MAX_EDGES)) {
    const key = `${r.from_id}|${r.field}|${r.to_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({
      from: String(r.from_id),
      to: String(r.to_id),
      field: String(r.field),
      predicate: r.predicate === null ? null : String(r.predicate),
      depth: Number(r.depth),
    });
  }

  // Batch-fetch node summaries (including the start entry)
  const ids = [...new Set([opts.startId, ...edges.flatMap((e) => [e.from, e.to])])];
  const nodeRes = await db.execute(sql`
    SELECT e.id, e.document_id, e.locale, e.status,
           ct.uid AS type_uid, ct.name AS type_name, ct.schema_org_type,
           COALESCE(
             e.values ->> (ct.definition ->> 'displayField'),
             e.values ->> 'title',
             e.values ->> 'name'
           ) AS display
    FROM entries e
    JOIN content_types ct ON ct.id = e.content_type_id
    WHERE e.id = ANY(${sql.param(ids)}::uuid[])
  `);
  const nodes: TraverseNode[] = (nodeRes.rows as Record<string, unknown>[]).map((r) => ({
    id: String(r.id),
    documentId: String(r.document_id),
    typeUid: String(r.type_uid),
    typeName: String(r.type_name),
    schemaOrgType: r.schema_org_type === null ? null : String(r.schema_org_type),
    locale: String(r.locale),
    status: String(r.status),
    display: r.display,
  }));

  const targets = path
    ? [...new Set(edges.filter((e) => e.depth === path.length).map((e) => e.to))]
    : [...new Set(edges.map((e) => e.to))];

  return {
    start: opts.startId,
    mode: path ? "path" : "depth",
    depth: maxDepth,
    nodes,
    edges,
    targets,
    truncated,
  };
}
