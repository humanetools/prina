/**
 * Taxonomy on the public delivery plane (22-IMPL-delivery-taxonomy).
 *
 * Three reads: the classification tree, a filter for entry lists ("everything under this node"),
 * and the nodes an entry sits in together with its attribute-set values. Nodes have no draft state —
 * a node is public once it exists; entries keep their own published / draft-token rule.
 *
 * This plane is outside the command pipeline, so nothing here is zod-validated on the way in: every
 * URL-derived value is checked by hand before it reaches SQL.
 */
import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { ContentTypeDefinition } from "@prina/shared";
import { components, entries, entryTaxonomyNodes, taxonomies, taxonomyNodes } from "../../db/schema/index.js";
import { NotFoundError } from "../../lib/errors.js";
import { TAXONOMY_UID_RE as UID_RE, type TaxonomyFilterSpec } from "../taxonomy/filter.js";
import { populateValuesList } from "./populate.js";
import type { DeliveryCtx } from "./service.js";

export interface EntryTaxonomy {
  taxonomy: string;
  nodeId: string;
  name: string;
  slug: string;
  path: string;
  /** component uid of the node's attribute set */
  attributeSet: string | null;
  attributes: Record<string, unknown> | null;
}

// The spec parser lives in the taxonomy module (shared with the management lists) — re-exported for existing importers
export { parseTaxonomyParams, parseTaxonomySpec, type TaxonomyFilterSpec } from "../taxonomy/filter.js";

async function taxonomyByUid(ctx: DeliveryCtx, uid: string) {
  const [row] = await ctx.db
    .select()
    .from(taxonomies)
    .where(and(eq(taxonomies.workspaceId, ctx.workspace.id), eq(taxonomies.uid, uid)))
    .limit(1);
  if (!row) throw new NotFoundError(`Taxonomy '${uid}' not found`);
  return row;
}

/**
 * One SQL condition per spec for an entry list. Descendants are included unless `exact` — that is
 * the point of a hierarchy. An unknown taxonomy or node is a 404: a removed category is a missing resource.
 */
export async function buildTaxonomyConditions(ctx: DeliveryCtx, specs: TaxonomyFilterSpec[], exact: boolean): Promise<SQL[]> {
  const conds: SQL[] = [];
  for (const spec of specs) {
    const taxonomy = await taxonomyByUid(ctx, spec.taxonomyUid);
    const [node] = await ctx.db
      .select({ id: taxonomyNodes.id })
      .from(taxonomyNodes)
      .where(and(eq(taxonomyNodes.taxonomyId, taxonomy.id), eq(taxonomyNodes.path, spec.path)))
      .limit(1);
    if (!node) throw new NotFoundError(`Taxonomy node '${spec.taxonomyUid}:${spec.path}' not found`);
    const match = exact ? sql`tn.id = ${node.id}` : sql`tn.path <@ ${spec.path}::ltree`;
    conds.push(sql`EXISTS (
      SELECT 1 FROM entry_taxonomy_nodes etn
      JOIN taxonomy_nodes tn ON tn.id = etn.node_id
      WHERE etn.entry_id = ${entries.id} AND tn.taxonomy_id = ${taxonomy.id} AND ${match}
    )`);
  }
  return conds;
}

export async function listDeliveryTaxonomies(ctx: DeliveryCtx) {
  const rows = await ctx.db
    .select({ uid: taxonomies.uid, name: taxonomies.name, description: taxonomies.description })
    .from(taxonomies)
    .where(eq(taxonomies.workspaceId, ctx.workspace.id))
    .orderBy(asc(taxonomies.uid));
  return { items: rows };
}

/** Flat, path-ordered (parents before children) — consumers assemble the tree from parentId */
export async function getDeliveryTaxonomy(ctx: DeliveryCtx, uid: string) {
  if (!UID_RE.test(uid)) throw new NotFoundError(`Taxonomy '${uid.slice(0, 80)}' not found`);
  const taxonomy = await taxonomyByUid(ctx, uid);
  const nodes = await ctx.db
    .select()
    .from(taxonomyNodes)
    .where(eq(taxonomyNodes.taxonomyId, taxonomy.id))
    .orderBy(asc(taxonomyNodes.path));
  return {
    uid: taxonomy.uid,
    name: taxonomy.name,
    description: taxonomy.description,
    nodes: nodes.map((n) => ({
      id: n.id,
      parentId: n.parentId,
      name: n.name,
      slug: n.slug,
      path: n.path,
      depth: n.path.split(".").length - 1,
      position: n.position,
      attributeSet: n.attributeComponentUid,
    })),
  };
}

/** Nodes (and attribute values) of each entry — one query for the whole page of entries */
export async function loadEntryTaxonomies(
  ctx: DeliveryCtx,
  entryIds: string[],
  opts: { populate?: boolean } = {},
): Promise<Map<string, EntryTaxonomy[]>> {
  const out = new Map<string, EntryTaxonomy[]>(entryIds.map((id) => [id, []]));
  if (entryIds.length === 0) return out;
  const rows = await ctx.db
    .select({
      entryId: entryTaxonomyNodes.entryId,
      attributes: entryTaxonomyNodes.attributeValues,
      nodeId: taxonomyNodes.id,
      name: taxonomyNodes.name,
      slug: taxonomyNodes.slug,
      path: taxonomyNodes.path,
      attributeSet: taxonomyNodes.attributeComponentUid,
      taxonomy: taxonomies.uid,
    })
    .from(entryTaxonomyNodes)
    .innerJoin(taxonomyNodes, eq(taxonomyNodes.id, entryTaxonomyNodes.nodeId))
    .innerJoin(taxonomies, eq(taxonomies.id, taxonomyNodes.taxonomyId))
    .where(and(eq(entryTaxonomyNodes.workspaceId, ctx.workspace.id), inArray(entryTaxonomyNodes.entryId, entryIds)))
    .orderBy(asc(taxonomies.uid), asc(taxonomyNodes.path));

  // populate: resolve media / relations inside attribute values with the attribute set's own definition
  const resolved = new Map<number, Record<string, unknown>>();
  if (opts.populate) {
    const uids = [...new Set(rows.filter((r) => r.attributes && r.attributeSet).map((r) => r.attributeSet!))];
    const defs = uids.length
      ? await ctx.db
          .select({ uid: components.uid, definition: components.definition })
          .from(components)
          .where(and(eq(components.workspaceId, ctx.workspace.id), inArray(components.uid, uids)))
      : [];
    for (const def of defs) {
      const idx = rows.map((r, i) => (r.attributeSet === def.uid && r.attributes ? i : -1)).filter((i) => i >= 0);
      const values = await populateValuesList(ctx, def.definition as ContentTypeDefinition, idx.map((i) => rows[i]!.attributes!));
      idx.forEach((rowIndex, k) => resolved.set(rowIndex, values[k]!));
    }
  }

  rows.forEach((r, i) => {
    out.get(r.entryId)?.push({
      taxonomy: r.taxonomy,
      nodeId: r.nodeId,
      name: r.name,
      slug: r.slug,
      path: r.path,
      attributeSet: r.attributeSet,
      attributes: resolved.get(i) ?? r.attributes ?? null,
    });
  });
  return out;
}
