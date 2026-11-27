/**
 * Taxonomy attachments of entries on the management plane — the shape `entry.get` returns, loaded for
 * any number of entries in one query so lists can carry it without a request per row (27-IMPL).
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import { entryTaxonomyNodes, taxonomies, taxonomyNodes } from "../../db/schema/index.js";
import type { CommandCtx } from "../../commands/context.js";

export interface EntryTaxonomyAttachment {
  nodeId: string;
  /** values of the node's entry component (33-IMPL naming) */
  entryComponentValues: Record<string, unknown> | null;
  name: string;
  path: string;
  entryComponentUid: string | null;
  /** the node's own attribute values */
  attributes: Record<string, unknown>;
  /** taxonomy uid — with `path` it forms the `<uid>:<path>` filter spec */
  taxonomy: string;
}

export async function loadEntryAttachments(ctx: CommandCtx, entryIds: string[]): Promise<Map<string, EntryTaxonomyAttachment[]>> {
  const out = new Map<string, EntryTaxonomyAttachment[]>(entryIds.map((id) => [id, []]));
  if (entryIds.length === 0) return out;
  const rows = await ctx.db
    .select({
      entryId: entryTaxonomyNodes.entryId,
      nodeId: entryTaxonomyNodes.nodeId,
      entryComponentValues: entryTaxonomyNodes.entryComponentValues,
      name: taxonomyNodes.name,
      path: taxonomyNodes.path,
      entryComponentUid: taxonomyNodes.entryComponentUid,
      attributes: taxonomyNodes.attributes,
      taxonomy: taxonomies.uid,
    })
    .from(entryTaxonomyNodes)
    .innerJoin(taxonomyNodes, eq(entryTaxonomyNodes.nodeId, taxonomyNodes.id))
    .innerJoin(taxonomies, eq(taxonomyNodes.taxonomyId, taxonomies.id))
    .where(and(eq(entryTaxonomyNodes.workspaceId, ctx.workspaceId), inArray(entryTaxonomyNodes.entryId, entryIds)))
    .orderBy(asc(taxonomies.uid), asc(taxonomyNodes.path));
  for (const { entryId, ...attachment } of rows) out.get(entryId)?.push(attachment);
  return out;
}
