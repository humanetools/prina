/**
 * Document (i18n group) queries (T2.4) + taxonomy attach (T2.5)
 * document = a set of independent per-locale entries sharing the same document_id.
 */
import { z } from "zod";
import { and, asc, eq, inArray } from "drizzle-orm";
import { PermissionAction, contentSubject } from "@prina/shared";
import {
  components,
  entries,
  entryTaxonomyNodes,
  taxonomyNodes,
} from "../../db/schema/index.js";
import { defineCommand } from "../../commands/define.js";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { assertValuesAgainstSchema } from "../../content/schema-compiler.js";
import { getContentTypeByUid } from "../content-type/repo.js";
import { maskReadableValues } from "../rbac/service.js";
import { getEntryScoped } from "./save-helpers.js";

const typeUid = z.string().min(1);

/** Per-locale entry status of a document — data source for the locale switcher (T3.4) */
export const entryListByDocument = defineCommand({
  name: "entry.list_by_document",
  resource: "entry",
  skipAudit: true,
  input: z.object({ typeUid, documentId: z.string().uuid() }),
  permission: (i) => ({
    action: PermissionAction.Read,
    subject: contentSubject(i.typeUid),
  }),
  async execute(input, ctx) {
    const contentType = await getContentTypeByUid(ctx.db, ctx.workspaceId, input.typeUid);
    const rows = await ctx.db
      .select()
      .from(entries)
      .where(
        and(
          eq(entries.workspaceId, ctx.workspaceId),
          eq(entries.contentTypeId, contentType.id),
          eq(entries.documentId, input.documentId),
        ),
      )
      .orderBy(asc(entries.locale));
    if (rows.length === 0) throw new NotFoundError("Document not found");
    const subject = contentSubject(input.typeUid);
    return Promise.all(
      rows.map(async (r) => ({
        ...r,
        values: await maskReadableValues(ctx, subject, r.values, r.locale),
      })),
    );
  },
});

/** Multi-taxonomy attach — full-replace semantics. Attribute set values validated against the component definition (§2.8) */
export const entrySetTaxonomies = defineCommand({
  name: "entry.set_taxonomies",
  resource: "entry",
  input: z.object({
    typeUid,
    id: z.string().uuid(),
    attachments: z
      .array(
        z.object({
          nodeId: z.string().uuid(),
          attributeValues: z.record(z.unknown()).nullable().default(null),
        }),
      )
      .max(100),
  }),
  permission: (i) => ({
    action: PermissionAction.Update,
    subject: contentSubject(i.typeUid),
  }),
  async execute(input, ctx) {
    const contentType = await getContentTypeByUid(ctx.db, ctx.workspaceId, input.typeUid);
    const entry = await getEntryScoped(ctx, contentType, input.id);

    const nodeIds = input.attachments.map((a) => a.nodeId);
    const nodes = nodeIds.length
      ? await ctx.db
          .select()
          .from(taxonomyNodes)
          .where(
            and(
              eq(taxonomyNodes.workspaceId, ctx.workspaceId),
              inArray(taxonomyNodes.id, nodeIds),
            ),
          )
      : [];
    const nodeMap = new Map(nodes.map((n) => [n.id, n]));
    const missing = nodeIds.filter((id) => !nodeMap.has(id));
    if (missing.length > 0) {
      throw new ValidationError(`Taxonomy node(s) not found: ${missing.join(", ")}`);
    }

    // Attribute set value validation (T2.5): uses the node's attributeComponentUid component definition
    for (const attach of input.attachments) {
      const node = nodeMap.get(attach.nodeId)!;
      if (!attach.attributeValues) continue;
      if (!node.attributeComponentUid) {
        throw new ValidationError(
          `Node '${node.name}' has no attribute set — attributeValues cannot be sent`,
        );
      }
      const [comp] = await ctx.db
        .select()
        .from(components)
        .where(
          and(
            eq(components.workspaceId, ctx.workspaceId),
            eq(components.uid, node.attributeComponentUid),
          ),
        )
        .limit(1);
      if (!comp) {
        throw new ValidationError(
          `Attribute set component '${node.attributeComponentUid}' not found`,
        );
      }
      const compiled = ctx.services.schemas.getOrCompile(
        ctx.workspaceId,
        `component:${comp.uid}`,
        comp.version,
        comp.definition,
        () => undefined,
      );
      assertValuesAgainstSchema(compiled, attach.attributeValues as Record<string, unknown>);
    }

    await ctx.db.delete(entryTaxonomyNodes).where(eq(entryTaxonomyNodes.entryId, entry.id));
    if (input.attachments.length > 0) {
      await ctx.db.insert(entryTaxonomyNodes).values(
        input.attachments.map((a) => ({
          workspaceId: ctx.workspaceId,
          entryId: entry.id,
          nodeId: a.nodeId,
          attributeValues: a.attributeValues,
        })),
      );
    }
    return { entryId: entry.id, attached: input.attachments.length };
  },
  resourceId: (i) => i.id,
  auditPayload: (i) => ({ typeUid: i.typeUid, count: i.attachments.length }),
});
