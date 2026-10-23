/** Entry SEO record commands (§0.11) — non-field entry metadata, same shape as taxonomy attach */
import { z } from "zod";
import { eq } from "drizzle-orm";
import { PermissionAction, contentSubject } from "@prina/shared";
import type { EntrySeo, WorkspaceSeoSettings } from "@prina/shared";
import { entries, workspaces } from "../../db/schema/index.js";
import { defineCommand } from "../../commands/define.js";
import { workspaceSeoSettings } from "../../delivery/seo.js";
import type { CommandCtx } from "../../commands/context.js";
import { getContentTypeByUid } from "../content-type/repo.js";
import { getEntryScoped } from "./save-helpers.js";
import { recordVersion } from "./versions.js";

/** Workspace-global SEO settings for advisory/emission paths that only hold a CommandCtx */
export async function loadWorkspaceSeo(ctx: CommandCtx): Promise<WorkspaceSeoSettings | null> {
  const [ws] = await ctx.db
    .select({ settings: workspaces.settings })
    .from(workspaces)
    .where(eq(workspaces.id, ctx.workspaceId))
    .limit(1);
  return workspaceSeoSettings(ws?.settings);
}

const absoluteUrl = z
  .string()
  .url()
  .refine((v) => /^https?:\/\//.test(v), "must be an absolute http(s) URL");

export const entrySeoSchema = z
  .object({
    metaTitle: z.string().max(200).optional(),
    metaDescription: z.string().max(500).optional(),
    canonical: absoluteUrl.optional(),
    ogImage: z.string().uuid().optional(),
    ogTitle: z.string().max(200).optional(),
    ogDescription: z.string().max(500).optional(),
    noindex: z.boolean().optional(),
  })
  .strict();

/** Full-replace semantics (like taxonomy attach): the panel always sends the complete record */
export const entrySetSeo = defineCommand({
  name: "entry.set_seo",
  resource: "entry",
  input: z.object({
    typeUid: z.string().min(1),
    id: z.string().uuid(),
    seo: entrySeoSchema.nullable(),
  }),
  permission: (i) => ({
    action: PermissionAction.Update,
    subject: contentSubject(i.typeUid),
  }),
  async execute(input, ctx) {
    const contentType = await getContentTypeByUid(ctx.db, ctx.workspaceId, input.typeUid);
    const entry = await getEntryScoped(ctx, contentType, input.id);
    const seo: EntrySeo | null =
      input.seo && Object.keys(input.seo).length > 0 ? input.seo : null;
    const [updated] = await ctx.db
      .update(entries)
      .set({ seo, updatedAt: new Date() })
      .where(eq(entries.id, entry.id))
      .returning();
    const version = await recordVersion(ctx, updated!);
    return { entry: updated!, version };
  },
  resourceId: (i) => i.id,
  auditPayload: (i) => ({
    typeUid: i.typeUid,
    keys: i.seo ? Object.keys(i.seo) : [],
  }),
});
