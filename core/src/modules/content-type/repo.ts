/** Content type/component lookup helpers — every query is workspace_id-scoped (Appendix A) */
import { and, eq } from "drizzle-orm";
import type { ContentTypeDefinition } from "@prina/shared";
import { contentTypes, components } from "../../db/schema/index.js";
import type { Db } from "../../db/client.js";
import { NotFoundError } from "../../lib/errors.js";

export type ContentTypeRow = typeof contentTypes.$inferSelect;

export async function getContentTypeByUid(
  db: Db,
  workspaceId: string,
  uid: string,
): Promise<ContentTypeRow> {
  const [row] = await db
    .select()
    .from(contentTypes)
    .where(and(eq(contentTypes.workspaceId, workspaceId), eq(contentTypes.uid, uid)))
    .limit(1);
  if (!row) throw new NotFoundError(`Content type '${uid}' not found`);
  return row;
}

export async function findContentTypeByUid(
  db: Db,
  workspaceId: string,
  uid: string,
): Promise<ContentTypeRow | undefined> {
  const [row] = await db
    .select()
    .from(contentTypes)
    .where(and(eq(contentTypes.workspaceId, workspaceId), eq(contentTypes.uid, uid)))
    .limit(1);
  return row;
}

/** Workspace component definition map — source for schema compilation's resolveComponent */
export async function loadComponentMap(
  db: Db,
  workspaceId: string,
): Promise<Map<string, ContentTypeDefinition>> {
  const rows = await db
    .select()
    .from(components)
    .where(eq(components.workspaceId, workspaceId));
  return new Map(rows.map((r) => [r.uid, r.definition]));
}
