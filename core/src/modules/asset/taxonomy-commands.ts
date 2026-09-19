/**
 * Taxonomy on assets (23-IMPL-dam-taxonomy) — attach nodes to an asset, read them back, filter a list by them.
 *
 * Assets share the taxonomies entries use. There are no attribute-set values here: what describes an
 * asset (alt, EXIF, analysis) already lives on the asset row. The filter spelling and meaning are the
 * delivery plane's (`<taxonomyUid>:<node.path>`, descendants included unless exact), so the parser is reused.
 */
import { z } from "zod";
import { and, asc, eq, inArray, type SQL } from "drizzle-orm";
import { PermissionAction, SystemSubject } from "@prina/shared";
import { assets, assetTaxonomyNodes, taxonomies, taxonomyNodes } from "../../db/schema/index.js";
import { defineCommand } from "../../commands/define.js";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import type { CommandCtx } from "../../commands/context.js";
import { taxonomyLinkConditions, type TaxonomyFilterSpec } from "../taxonomy/filter.js";

export interface AssetTaxonomy {
  taxonomy: string;
  nodeId: string;
  name: string;
  slug: string;
  path: string;
}

/** Nodes of each asset — one query for the whole list */
export async function loadAssetTaxonomies(ctx: CommandCtx, assetIds: string[]): Promise<Map<string, AssetTaxonomy[]>> {
  const out = new Map<string, AssetTaxonomy[]>(assetIds.map((id) => [id, []]));
  if (assetIds.length === 0) return out;
  const rows = await ctx.db
    .select({
      assetId: assetTaxonomyNodes.assetId,
      nodeId: taxonomyNodes.id,
      name: taxonomyNodes.name,
      slug: taxonomyNodes.slug,
      path: taxonomyNodes.path,
      taxonomy: taxonomies.uid,
    })
    .from(assetTaxonomyNodes)
    .innerJoin(taxonomyNodes, eq(taxonomyNodes.id, assetTaxonomyNodes.nodeId))
    .innerJoin(taxonomies, eq(taxonomies.id, taxonomyNodes.taxonomyId))
    .where(and(eq(assetTaxonomyNodes.workspaceId, ctx.workspaceId), inArray(assetTaxonomyNodes.assetId, assetIds)))
    .orderBy(asc(taxonomies.uid), asc(taxonomyNodes.path));
  for (const { assetId, ...node } of rows) out.get(assetId)?.push(node);
  return out;
}

/** Filter conditions for an asset list — the shared rule (descendants unless exact, 404 on an unknown node) */
export const assetTaxonomyConditions = (ctx: CommandCtx, specs: TaxonomyFilterSpec[], exact: boolean): Promise<SQL[]> =>
  taxonomyLinkConditions(ctx, specs, exact, { table: "asset_taxonomy_nodes", fk: "asset_id", id: assets.id });

/** Replace the asset's taxonomy attachments — the full set every time, `[]` detaches everything */
export const assetSetTaxonomies = defineCommand({
  name: "asset.set_taxonomies",
  resource: "asset",
  input: z.object({
    id: z.string().uuid(),
    nodeIds: z.array(z.string().uuid()).max(100),
  }),
  permission: () => ({ action: PermissionAction.Update, subject: SystemSubject.Media }),
  async execute(input, ctx) {
    const [asset] = await ctx.db
      .select({ id: assets.id, filename: assets.filename })
      .from(assets)
      .where(and(eq(assets.workspaceId, ctx.workspaceId), eq(assets.id, input.id)))
      .limit(1);
    if (!asset) throw new NotFoundError(`Asset ${input.id} not found`);

    const nodeIds = [...new Set(input.nodeIds)];
    const found = nodeIds.length
      ? await ctx.db
          .select({ id: taxonomyNodes.id })
          .from(taxonomyNodes)
          .where(and(eq(taxonomyNodes.workspaceId, ctx.workspaceId), inArray(taxonomyNodes.id, nodeIds)))
      : [];
    const known = new Set(found.map((n) => n.id));
    const missing = nodeIds.filter((id) => !known.has(id));
    if (missing.length > 0) {
      throw new ValidationError(`Taxonomy node(s) not found: ${missing.join(", ")}`);
    }

    await ctx.db.delete(assetTaxonomyNodes).where(eq(assetTaxonomyNodes.assetId, asset.id));
    if (nodeIds.length > 0) {
      await ctx.db
        .insert(assetTaxonomyNodes)
        .values(nodeIds.map((nodeId) => ({ workspaceId: ctx.workspaceId, assetId: asset.id, nodeId })));
    }
    const taxonomiesOfAsset = (await loadAssetTaxonomies(ctx, [asset.id])).get(asset.id) ?? [];
    return { assetId: asset.id, filename: asset.filename, taxonomies: taxonomiesOfAsset };
  },
  resourceId: (i) => i.id,
  auditPayload: (_i, o) => ({ filename: o.filename, nodes: o.taxonomies.map((n) => `${n.taxonomy}:${n.path}`) }),
});
