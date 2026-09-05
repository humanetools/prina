/** Taxonomy hierarchy CRUD (T2.5) — ltree paths. Shared by Admin and MCP */
import { z } from "zod";
import { and, asc, eq, sql } from "drizzle-orm";
import { PermissionAction, SystemSubject } from "@prina/shared";
import { taxonomies, taxonomyNodes } from "../../db/schema/index.js";
import { defineCommand } from "../../commands/define.js";
import { ConflictError, NotFoundError, ValidationError } from "../../lib/errors.js";
import type { CommandCtx } from "../../commands/context.js";

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

export const taxonomyNodeCreate = defineCommand({
  name: "taxonomy_node.create",
  resource: "taxonomy_node",
  input: z.object({
    taxonomyUid: uidSchema,
    parentId: z.string().uuid().nullable().default(null),
    name: z.string().min(1).max(200),
    slug: slugSchema,
    /** attribute set (§2.8): component uid exposed to entries under this node */
    attributeComponentUid: z.string().nullable().default(null),
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
    const [row] = await ctx.db
      .insert(taxonomyNodes)
      .values({
        workspaceId: ctx.workspaceId,
        taxonomyId: taxonomy.id,
        parentId: input.parentId,
        name: input.name,
        slug: input.slug,
        path,
        attributeComponentUid: input.attributeComponentUid,
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

/** Move/rename — bulk-update subtree paths with ltree operations */
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
