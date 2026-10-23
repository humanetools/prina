/** Taxonomy hierarchy CRUD (T2.5) — ltree paths. Node attributes + entry components (33-IMPL). Shared by Admin and MCP */
import { z } from "zod";
import { and, asc, count, eq, sql } from "drizzle-orm";
import { PermissionAction, SystemSubject } from "@prina/shared";
import { assetTaxonomyNodes, components, entryTaxonomyNodes, taxonomies, taxonomyNodes } from "../../db/schema/index.js";
import { defineCommand } from "../../commands/define.js";
import { ConflictError, NotFoundError, ValidationError } from "../../lib/errors.js";
import type { CommandCtx } from "../../commands/context.js";
import { attributeFieldsSchema, pruneNodeAttributes, validateNodeAttributes } from "./attributes.js";

const uidSchema = z.string().regex(/^[a-z][a-z0-9_-]{1,63}$/);
const slugSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);

/** slug → ltree label (alphanumeric/_ only, hyphens become _) */
export function ltreeLabel(slug: string): string {
  return slug.replace(/[^a-zA-Z0-9_]/g, "_");
}

const taxonomyPermission = (action: string) => () => ({
  action,
  subject: SystemSubject.Taxonomy,
});

export const taxonomyCreate = defineCommand({
  name: "taxonomy.create",
  resource: "taxonomy",
  input: z.object({
    uid: uidSchema,
    name: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
    /** attribute definitions every node of this taxonomy carries values for (33-IMPL) */
    attributeFields: attributeFieldsSchema.default([]),
  }),
  permission: taxonomyPermission(PermissionAction.Create),
  async execute(input, ctx) {
    const [existing] = await ctx.db
      .select({ id: taxonomies.id })
      .from(taxonomies)
      .where(and(eq(taxonomies.workspaceId, ctx.workspaceId), eq(taxonomies.uid, input.uid)))
      .limit(1);
    if (existing) throw new ConflictError(`Taxonomy '${input.uid}' already exists`);
    const [row] = await ctx.db
      .insert(taxonomies)
      .values({ workspaceId: ctx.workspaceId, ...input })
      .returning();
    return row!;
  },
  resourceId: (_i, o) => o.id,
  auditPayload: (i) => ({ uid: i.uid }),
});

/**
 * Edit a taxonomy: name, description, attribute definitions (33-IMPL). Removing a field drops its
 * values from every node — no orphan keys; changing a type keeps values (they are re-validated on the
 * next node save, not here).
 */
export const taxonomyUpdate = defineCommand({
  name: "taxonomy.update",
  resource: "taxonomy",
  input: z.object({
    uid: uidSchema,
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).nullable().optional(),
    attributeFields: attributeFieldsSchema.optional(),
  }),
  permission: taxonomyPermission(PermissionAction.Update),
  async execute(input, ctx) {
    const taxonomy = await getTaxonomyByUid(ctx, input.uid);
    const patch: Partial<typeof taxonomies.$inferInsert> = { updatedAt: new Date() };
    if (input.name !== undefined) patch.name = input.name;
    if (input.description !== undefined) patch.description = input.description;
    if (input.attributeFields !== undefined) {
      patch.attributeFields = input.attributeFields;
      const removed = taxonomy.attributeFields.filter((f) => !input.attributeFields!.some((g) => g.name === f.name));
      if (removed.length > 0) {
        const nodes = await ctx.db
          .select({ id: taxonomyNodes.id, attributes: taxonomyNodes.attributes })
          .from(taxonomyNodes)
          .where(eq(taxonomyNodes.taxonomyId, taxonomy.id));
        for (const n of nodes) {
          if (!removed.some((f) => f.name in n.attributes)) continue;
          await ctx.db
            .update(taxonomyNodes)
            .set({ attributes: pruneNodeAttributes(input.attributeFields, n.attributes), updatedAt: new Date() })
            .where(eq(taxonomyNodes.id, n.id));
        }
      }
    }
    const [updated] = await ctx.db.update(taxonomies).set(patch).where(eq(taxonomies.id, taxonomy.id)).returning();
    return updated!;
  },
  resourceId: (_i, o) => o.id,
  auditPayload: (i) => ({ uid: i.uid, attributeFields: i.attributeFields?.map((f) => f.name) }),
});

export const taxonomyList = defineCommand({
  name: "taxonomy.list",
  resource: "taxonomy",
  skipAudit: true,
  input: z.object({}).default({}),
  async execute(_input, ctx) {
    return ctx.db
      .select()
      .from(taxonomies)
      .where(eq(taxonomies.workspaceId, ctx.workspaceId))
      .orderBy(asc(taxonomies.uid));
  },
});

export async function getTaxonomyByUid(ctx: CommandCtx, uid: string) {
  const [row] = await ctx.db
    .select()
    .from(taxonomies)
    .where(and(eq(taxonomies.workspaceId, ctx.workspaceId), eq(taxonomies.uid, uid)))
    .limit(1);
  if (!row) throw new NotFoundError(`Taxonomy '${uid}' not found`);
  return row;
}

/**
 * Delete a taxonomy with its whole tree (29-IMPL). Attachments go with the nodes (FK cascade) — entries and
 * assets themselves are untouched, they only lose the classification. What disappeared is returned and audited.
 */
export const taxonomyDelete = defineCommand({
  name: "taxonomy.delete",
  resource: "taxonomy",
  input: z.object({ uid: z.string().min(1).max(64) }),
  permission: taxonomyPermission(PermissionAction.Delete),
  async execute(input, ctx) {
    const taxonomy = await getTaxonomyByUid(ctx, input.uid);
    const countWhere = async (link: typeof entryTaxonomyNodes | typeof assetTaxonomyNodes) => {
      const [row] = await ctx.db
        .select({ value: count() })
        .from(link)
        .innerJoin(taxonomyNodes, eq(taxonomyNodes.id, link.nodeId))
        .where(eq(taxonomyNodes.taxonomyId, taxonomy.id));
      return Number(row?.value ?? 0);
    };
    const [nodeRow] = await ctx.db.select({ value: count() }).from(taxonomyNodes).where(eq(taxonomyNodes.taxonomyId, taxonomy.id));
    const removed = {
      nodes: Number(nodeRow?.value ?? 0),
      entryAttachments: await countWhere(entryTaxonomyNodes),
      assetAttachments: await countWhere(assetTaxonomyNodes),
    };
    await ctx.db.delete(taxonomies).where(eq(taxonomies.id, taxonomy.id));
    return { id: taxonomy.id, uid: taxonomy.uid, name: taxonomy.name, ...removed };
  },
  resourceId: (_i, o) => o.id,
  auditPayload: (_i, o) => ({ uid: o.uid, nodes: o.nodes, entryAttachments: o.entryAttachments, assetAttachments: o.assetAttachments }),
});

export const taxonomyNodeCreate = defineCommand({
  name: "taxonomy_node.create",
  resource: "taxonomy_node",
  input: z.object({
    taxonomyUid: uidSchema,
    parentId: z.string().uuid().nullable().default(null),
    name: z.string().min(1).max(200),
    slug: slugSchema,
    /** entry component (§2.8): component uid exposed to entries under this node */
    entryComponentUid: z.string().nullable().default(null),
    /** attribute values — keys must be the taxonomy's attributeFields (33-IMPL) */
    attributes: z.record(z.unknown()).default({}),
    position: z.number().int().default(0),
  }),
  permission: taxonomyPermission(PermissionAction.Create),
  async execute(input, ctx) {
    const taxonomy = await getTaxonomyByUid(ctx, input.taxonomyUid);
    let path = ltreeLabel(input.slug);
    if (input.parentId) {
      const [parent] = await ctx.db
        .select()
        .from(taxonomyNodes)
        .where(and(eq(taxonomyNodes.id, input.parentId), eq(taxonomyNodes.taxonomyId, taxonomy.id)))
        .limit(1);
      if (!parent) throw new NotFoundError("Parent node not found");
      path = `${parent.path}.${ltreeLabel(input.slug)}`;
    }
    const [dup] = await ctx.db
      .select({ id: taxonomyNodes.id })
      .from(taxonomyNodes)
      .where(and(eq(taxonomyNodes.taxonomyId, taxonomy.id), eq(taxonomyNodes.path, path)))
      .limit(1);
    if (dup) throw new ConflictError(`Path '${path}' already exists`);
    if (input.entryComponentUid) await assertComponentExists(ctx, input.entryComponentUid);
    const [row] = await ctx.db
      .insert(taxonomyNodes)
      .values({
        workspaceId: ctx.workspaceId,
        taxonomyId: taxonomy.id,
        parentId: input.parentId,
        name: input.name,
        slug: input.slug,
        path,
        entryComponentUid: input.entryComponentUid,
        attributes: validateNodeAttributes(taxonomy.attributeFields, input.attributes),
        position: input.position,
      })
      .returning();
    return row!;
  },
  resourceId: (_i, o) => o.id,
  auditPayload: (i) => ({ taxonomyUid: i.taxonomyUid, slug: i.slug }),
});

/** Tree query — flat list sorted by path (UI assembles the tree) */
export const taxonomyTree = defineCommand({
  name: "taxonomy.tree",
  resource: "taxonomy",
  skipAudit: true,
  input: z.object({ taxonomyUid: uidSchema }),
  async execute(input, ctx) {
    const taxonomy = await getTaxonomyByUid(ctx, input.taxonomyUid);
    return ctx.db
      .select()
      .from(taxonomyNodes)
      .where(eq(taxonomyNodes.taxonomyId, taxonomy.id))
      .orderBy(asc(taxonomyNodes.path), asc(taxonomyNodes.position));
  },
});

async function assertComponentExists(ctx: CommandCtx, uid: string): Promise<void> {
  const [comp] = await ctx.db
    .select({ id: components.id })
    .from(components)
    .where(and(eq(components.workspaceId, ctx.workspaceId), eq(components.uid, uid)))
    .limit(1);
  if (!comp) throw new ValidationError(`Component '${uid}' does not exist`);
}

/**
 * Edit a node in place — display name, slug, entry component, attribute values. A new slug rewrites the
 * path of the node and of everything under it (same ltree rewrite as a move); re-parenting is `taxonomy_node.move`.
 */
export const taxonomyNodeUpdate = defineCommand({
  name: "taxonomy_node.update",
  resource: "taxonomy_node",
  input: z.object({
    nodeId: z.string().uuid(),
    name: z.string().min(1).max(200).optional(),
    slug: slugSchema.optional(),
    /** component uid, or null to detach. Values already stored on attachments are kept as they are */
    entryComponentUid: z.string().nullable().optional(),
    /** attribute values — replaces the node's values as a whole (send every field you want kept) */
    attributes: z.record(z.unknown()).optional(),
  }),
  permission: taxonomyPermission(PermissionAction.Update),
  async execute(input, ctx) {
    const [node] = await ctx.db
      .select()
      .from(taxonomyNodes)
      .where(and(eq(taxonomyNodes.id, input.nodeId), eq(taxonomyNodes.workspaceId, ctx.workspaceId)))
      .limit(1);
    if (!node) throw new NotFoundError("Node not found");
    if (input.entryComponentUid) await assertComponentExists(ctx, input.entryComponentUid);
    let attributes: Record<string, unknown> | undefined;
    if (input.attributes !== undefined) {
      const [taxonomy] = await ctx.db.select({ attributeFields: taxonomies.attributeFields }).from(taxonomies).where(eq(taxonomies.id, node.taxonomyId)).limit(1);
      attributes = validateNodeAttributes(taxonomy?.attributeFields ?? [], input.attributes);
    }
    if (input.slug !== undefined && input.slug !== node.slug) {
      const parentPath = node.path.includes(".") ? node.path.slice(0, node.path.lastIndexOf(".")) : "";
      const newPath = parentPath ? `${parentPath}.${ltreeLabel(input.slug)}` : ltreeLabel(input.slug);
      if (newPath !== node.path) {
        const [dup] = await ctx.db
          .select({ id: taxonomyNodes.id })
          .from(taxonomyNodes)
          .where(and(eq(taxonomyNodes.taxonomyId, node.taxonomyId), eq(taxonomyNodes.path, newPath)))
          .limit(1);
        if (dup) throw new ConflictError(`Path '${newPath}' already exists`);
        await ctx.db.execute(sql`
          UPDATE taxonomy_nodes
          SET path = CASE
                WHEN path = ${node.path}::ltree THEN ${newPath}::ltree
                ELSE ${newPath}::ltree || subpath(path, nlevel(${node.path}::ltree))
              END,
              updated_at = now()
          WHERE taxonomy_id = ${node.taxonomyId} AND path <@ ${node.path}::ltree
        `);
      }
    }
    const patch: Partial<typeof taxonomyNodes.$inferInsert> = { updatedAt: new Date() };
    if (input.name !== undefined) patch.name = input.name;
    if (input.slug !== undefined) patch.slug = input.slug;
    if (input.entryComponentUid !== undefined) patch.entryComponentUid = input.entryComponentUid;
    if (attributes !== undefined) patch.attributes = attributes;
    const [updated] = await ctx.db.update(taxonomyNodes).set(patch).where(eq(taxonomyNodes.id, node.id)).returning();
    return updated!;
  },
  resourceId: (i) => i.nodeId,
  auditPayload: (i) => ({ name: i.name, slug: i.slug, entryComponentUid: i.entryComponentUid, attributes: i.attributes ? Object.keys(i.attributes) : undefined }),
});

/** Move — bulk-update subtree paths with ltree operations */
export const taxonomyNodeMove = defineCommand({
  name: "taxonomy_node.move",
  resource: "taxonomy_node",
  input: z.object({
    nodeId: z.string().uuid(),
    newParentId: z.string().uuid().nullable(),
  }),
  permission: taxonomyPermission(PermissionAction.Update),
  async execute(input, ctx) {
    const [node] = await ctx.db
      .select()
      .from(taxonomyNodes)
      .where(and(eq(taxonomyNodes.id, input.nodeId), eq(taxonomyNodes.workspaceId, ctx.workspaceId)))
      .limit(1);
    if (!node) throw new NotFoundError("Node not found");

    let newBase = ltreeLabel(node.slug);
    if (input.newParentId) {
      const [parent] = await ctx.db
        .select()
        .from(taxonomyNodes)
        .where(and(eq(taxonomyNodes.id, input.newParentId), eq(taxonomyNodes.taxonomyId, node.taxonomyId)))
        .limit(1);
      if (!parent) throw new NotFoundError("New parent node not found");
      if (parent.path === node.path || parent.path.startsWith(`${node.path}.`)) {
        throw new ValidationError("Cannot move a node into itself or its descendants");
      }
      newBase = `${parent.path}.${ltreeLabel(node.slug)}`;
    }

    // Replace paths of self + subtree in bulk. For self, subpath yields an empty path, hence the CASE branch
    await ctx.db.execute(sql`
      UPDATE taxonomy_nodes
      SET path = CASE
            WHEN path = ${node.path}::ltree THEN ${newBase}::ltree
            ELSE ${newBase}::ltree || subpath(path, nlevel(${node.path}::ltree))
          END,
          parent_id = CASE WHEN id = ${node.id} THEN ${input.newParentId} ELSE parent_id END,
          updated_at = now()
      WHERE taxonomy_id = ${node.taxonomyId} AND path <@ ${node.path}::ltree
    `);
    const [updated] = await ctx.db
      .select()
      .from(taxonomyNodes)
      .where(eq(taxonomyNodes.id, node.id))
      .limit(1);
    return updated!;
  },
  resourceId: (i) => i.nodeId,
});

export const taxonomyNodeDelete = defineCommand({
  name: "taxonomy_node.delete",
  resource: "taxonomy_node",
  input: z.object({ nodeId: z.string().uuid() }),
  permission: taxonomyPermission(PermissionAction.Delete),
  async execute(input, ctx) {
    const [node] = await ctx.db
      .select()
      .from(taxonomyNodes)
      .where(and(eq(taxonomyNodes.id, input.nodeId), eq(taxonomyNodes.workspaceId, ctx.workspaceId)))
      .limit(1);
    if (!node) throw new NotFoundError("Node not found");
    // Delete the entire subtree (attachments are cleaned up via FK cascade)
    await ctx.db.execute(sql`
      DELETE FROM taxonomy_nodes
      WHERE taxonomy_id = ${node.taxonomyId} AND path <@ ${node.path}::ltree
    `);
    return { id: node.id, path: node.path };
  },
  resourceId: (i) => i.nodeId,
  auditPayload: (_i, o) => ({ path: o.path }),
});
