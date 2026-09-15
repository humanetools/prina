/** T9.2 knowledge-graph multi-hop query command — shared by Admin and MCP; actual traversal in delivery/traverse */
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { PermissionAction, contentSubject } from "@prina/shared";
import { entries } from "../../db/schema/index.js";
import { defineCommand } from "../../commands/define.js";
import { NotFoundError } from "../../lib/errors.js";
import { getContentTypeByUid } from "../content-type/repo.js";
import { traverseGraph, TRAVERSE_MAX_DEPTH } from "../delivery/traverse.js";

const fieldName = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/);

export const graphTraverse = defineCommand({
  name: "graph.traverse",
  resource: "entry",
  skipAudit: true,
  input: z.object({
    typeUid: z.string().min(1),
    id: z.string().uuid(),
    /** Chain of relation field names (e.g. ["series","brand"]) — presence enables path mode */
    path: z.array(fieldName).min(1).max(TRAVERSE_MAX_DEPTH).optional(),
    /** Without path, expand all relations N hops (default 1) */
    depth: z.number().int().min(1).max(TRAVERSE_MAX_DEPTH).optional(),
    /** If true, walk only published entries (Admin default includes drafts) */
    publishedOnly: z.boolean().default(false),
  }),
  permission: (i) => ({
    action: PermissionAction.Read,
    subject: contentSubject(i.typeUid),
  }),
  async execute(input, ctx) {
    // Verify the start entry belongs to the declared type — aligns type permission with the actual target
    const contentType = await getContentTypeByUid(ctx.db, ctx.workspaceId, input.typeUid);
    const [entry] = await ctx.db
      .select({ id: entries.id })
      .from(entries)
      .where(and(eq(entries.id, input.id), eq(entries.contentTypeId, contentType.id)))
      .limit(1);
    if (!entry) throw new NotFoundError(`Entry '${input.id}' not found in '${input.typeUid}'`);

    return traverseGraph(ctx.db, ctx.workspaceId, {
      startId: input.id,
      path: input.path,
      depth: input.depth,
      publishedOnly: input.publishedOnly,
    });
  },
});
