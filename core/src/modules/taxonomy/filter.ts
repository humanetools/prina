/**
 * Taxonomy filter — the `<taxonomyUid>:<node.path>` spec shared by every list that can be narrowed by
 * classification: delivery entries (22-IMPL), assets (23-IMPL), management entries (27-IMPL).
 *
 * A leaf module on purpose: entry / asset commands import it, so it must not pull in the delivery
 * service (an ESM import cycle there breaks zod schemas built at module load).
 */
import { and, eq, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { taxonomyNodes } from "../../db/schema/index.js";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import type { CommandCtx } from "../../commands/context.js";
import { getTaxonomyByUid, ltreeLabel } from "./commands.js";

export interface TaxonomyFilterSpec {
  taxonomyUid: string;
  /** ltree path, already label-safe */
  path: string;
}

export const TAXONOMY_UID_RE = /^[a-z][a-z0-9_-]{1,63}$/;
const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MAX_DEPTH = 32;
const MAX_FILTERS = 8;

/** `<taxonomyUid>:<path>` — path as the tree prints it (`a.b`); slug spelling (`-`) is accepted too */
export function parseTaxonomySpec(raw: string): TaxonomyFilterSpec {
  const bad = () => new ValidationError("taxonomy filter must look like '<taxonomyUid>:<node.path>'", { value: raw.slice(0, 200) });
  if (raw.length > 2200) throw bad();
  const colon = raw.indexOf(":");
  if (colon <= 0) throw bad();
  const taxonomyUid = raw.slice(0, colon);
  const segments = raw.slice(colon + 1).split(".");
  if (!TAXONOMY_UID_RE.test(taxonomyUid) || segments.length > MAX_DEPTH || !segments.every((s) => SEGMENT_RE.test(s))) throw bad();
  return { taxonomyUid, path: segments.map(ltreeLabel).join(".") };
}

/** `?taxonomy=` from a query string — one value or a repeated parameter; ANDed */
export function parseTaxonomyParams(value: unknown): TaxonomyFilterSpec[] {
  if (value === undefined || value === null || value === "") return [];
  const list = Array.isArray(value) ? value : [value];
  if (list.length > MAX_FILTERS) throw new ValidationError(`At most ${MAX_FILTERS} taxonomy filters per request`);
  return list.map((v) => {
    if (typeof v !== "string") throw new ValidationError("taxonomy filter must be a string");
    return parseTaxonomySpec(v);
  });
}

/** `taxonomyExact` as it arrives from a query string or a JSON caller */
export const isExact = (v: unknown) => v === true || v === "1" || v === "true";

/** The table that attaches taxonomy nodes to the listed rows */
export interface TaxonomyLink {
  /** link table — a fixed identifier from the caller, never user input */
  table: "entry_taxonomy_nodes" | "asset_taxonomy_nodes";
  /** its column pointing at the listed row */
  fk: "entry_id" | "asset_id";
  /** the listed row's id column */
  id: AnyColumn;
}

/**
 * One SQL condition per spec for a management-plane list. Descendants are included unless `exact`.
 * An unknown taxonomy or node is a 404 — a removed category is a missing resource, same as on delivery.
 */
export async function taxonomyLinkConditions(ctx: CommandCtx, specs: TaxonomyFilterSpec[], exact: boolean, link: TaxonomyLink): Promise<SQL[]> {
  const conds: SQL[] = [];
  for (const spec of specs) {
    const taxonomy = await getTaxonomyByUid(ctx, spec.taxonomyUid);
    const [node] = await ctx.db
      .select({ id: taxonomyNodes.id })
      .from(taxonomyNodes)
      .where(and(eq(taxonomyNodes.taxonomyId, taxonomy.id), eq(taxonomyNodes.path, spec.path)))
      .limit(1);
    if (!node) throw new NotFoundError(`Taxonomy node '${spec.taxonomyUid}:${spec.path}' not found`);
    const match = exact ? sql`tn.id = ${node.id}` : sql`tn.path <@ ${spec.path}::ltree`;
    conds.push(sql`EXISTS (
      SELECT 1 FROM ${sql.raw(link.table)} l
      JOIN taxonomy_nodes tn ON tn.id = l.node_id
      WHERE l.${sql.raw(link.fk)} = ${link.id} AND tn.taxonomy_id = ${taxonomy.id} AND ${match}
    )`);
  }
  return conds;
}
