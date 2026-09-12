/** Template bundle commands (T5.1/T5.3/T5.4) — shared by editor UI and MCP */
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { PermissionAction, SystemSubject } from "@prina/shared";
import { templates, workspaces } from "../../db/schema/index.js";
import { defineCommand } from "../../commands/define.js";
import { NotFoundError } from "../../lib/errors.js";
import type { CommandCtx } from "../../commands/context.js";
import { getContentTypeByUid } from "../content-type/repo.js";
import { assertPermissionInExecute, canActor } from "../rbac/service.js";
import { validateGa4Config } from "../../delivery/ga4.js";
import { renderLiquid } from "../../delivery/liquid.js";
import { auditRenderedHtml } from "../../delivery/audit.js";
import {
  buildHeadTags,
  displayValueOf,
  seoTypeOptions,
  serializeHeadTags,
} from "../../delivery/seo.js";
import type { AuditFinding } from "@prina/shared";
import { computeAltAdvisories, computePublishAdvisories } from "../entry/advisories.js";
import { loadWorkspaceSeo } from "../entry/seo.js";
import { getEntryScoped, loadParent } from "../entry/save-helpers.js";
import { resolveEffectiveValues } from "../entry/variants.js";

const typeUid = z.string().min(1);

export async function workspaceCurrency(ctx: CommandCtx): Promise<string | undefined> {
  const [ws] = await ctx.db
    .select({ settings: workspaces.settings })
    .from(workspaces)
    .where(eq(workspaces.id, ctx.workspaceId))
    .limit(1);
  return (ws?.settings as { currency?: string } | undefined)?.currency;
}

export async function getCurrentTemplate(ctx: CommandCtx, contentTypeId: string) {
  const [row] = await ctx.db
    .select()
    .from(templates)
    .where(and(eq(templates.contentTypeId, contentTypeId), eq(templates.isCurrent, true)))
    .limit(1);
  return row;
}

/**
 * Save = publish a new version (3-file bundle per version, §2.4).
 * js changes are developer-only — enforced by the API independent of UI lock (T5.3 DoD, absolute principle 6)
 */
export const templateSave = defineCommand({
  name: "template.save",
  resource: "template",
  input: z.object({
    typeUid,
    liquid: z.string().max(200_000),
    css: z.string().max(200_000),
    /** if omitted, previous version's js is kept — passing it requires template_script permission */
    js: z.string().max(200_000).optional(),
    events: z.unknown().optional(),
  }),
  permission: () => ({
    action: PermissionAction.Update,
    subject: SystemSubject.Templates,
  }),
  async execute(input, ctx) {
    const contentType = await getContentTypeByUid(ctx.db, ctx.workspaceId, input.typeUid);
    const current = await getCurrentTemplate(ctx, contentType.id);

    let js = current?.js ?? "";
    if (input.js !== undefined && input.js !== js) {
      // Attempt to save script.js — developer role only (§2.4)
      await assertPermissionInExecute(ctx, {
        action: PermissionAction.Update,
        subject: SystemSubject.TemplateScript,
      });
      js = input.js;
    }

    const events =
      input.events !== undefined
        ? validateGa4Config(input.events, await workspaceCurrency(ctx))
        : ((current?.events as Record<string, unknown>) ?? {});

    const version = (current?.version ?? 0) + 1;
    await ctx.db
      .update(templates)
      .set({ isCurrent: false })
      .where(and(eq(templates.contentTypeId, contentType.id), eq(templates.isCurrent, true)));
    const [row] = await ctx.db
      .insert(templates)
      .values({
        workspaceId: ctx.workspaceId,
        contentTypeId: contentType.id,
        name: "default",
        version,
        liquid: input.liquid,
        css: input.css,
        js,
        events: events as Record<string, unknown>,
        isCurrent: true,
      })
      .returning();
    return row!;
  },
  resourceId: (_i, o) => o.id,
  auditPayload: (i, o) => ({
    typeUid: i.typeUid,
    version: o.version,
    jsChanged: i.js !== undefined,
  }),
});

export const templateGet = defineCommand({
  name: "template.get",
  resource: "template",
  skipAudit: true,
  input: z.object({ typeUid }),
  permission: () => ({
    action: PermissionAction.Read,
    subject: SystemSubject.Templates,
  }),
  async execute(input, ctx) {
    const contentType = await getContentTypeByUid(ctx.db, ctx.workspaceId, input.typeUid);
    const current = await getCurrentTemplate(ctx, contentType.id);
    const versions = await ctx.db
      .select({
        id: templates.id,
        version: templates.version,
        isCurrent: templates.isCurrent,
        createdAt: templates.createdAt,
      })
      .from(templates)
      .where(eq(templates.contentTypeId, contentType.id))
      .orderBy(desc(templates.version));
    // For script.js tab lock decisions (UI shows it, API rejects saves — enforced on both sides)
    const canEditScript = await canActor(ctx, {
      action: PermissionAction.Update,
      subject: SystemSubject.TemplateScript,
    });
    return { current: current ?? null, versions, canEditScript };
  },
});

export const templateSetCurrent = defineCommand({
  name: "template.set_current",
  resource: "template",
  input: z.object({ typeUid, version: z.number().int().positive() }),
  permission: () => ({
    action: PermissionAction.Update,
    subject: SystemSubject.Templates,
  }),
  async execute(input, ctx) {
    const contentType = await getContentTypeByUid(ctx.db, ctx.workspaceId, input.typeUid);
    const [target] = await ctx.db
      .select()
      .from(templates)
      .where(
        and(eq(templates.contentTypeId, contentType.id), eq(templates.version, input.version)),
      )
      .limit(1);
    if (!target) throw new NotFoundError(`Template v${input.version} not found`);
    await ctx.db
      .update(templates)
      .set({ isCurrent: false })
      .where(and(eq(templates.contentTypeId, contentType.id), eq(templates.isCurrent, true)));
    await ctx.db.update(templates).set({ isCurrent: true }).where(eq(templates.id, target.id));
    return target;
  },
  auditPayload: (i) => ({ typeUid: i.typeUid, version: i.version }),
});

/** Live preview (T5.3/T5.5) — includes drafts, accepts the editor's unsaved sources too */
export const templateRenderPreview = defineCommand({
  name: "template.render_preview",
  resource: "template",
  skipAudit: true,
  input: z.object({
    typeUid,
    entryId: z.string().uuid(),
    /** if omitted, the currently published template is used */
    liquid: z.string().max(200_000).optional(),
    css: z.string().max(200_000).optional(),
  }),
  permission: (i) => ({
    action: PermissionAction.Read,
    subject: `content:${i.typeUid}`,
  }),
  async execute(input, ctx) {
    const contentType = await getContentTypeByUid(ctx.db, ctx.workspaceId, input.typeUid);
    const entry = await getEntryScoped(ctx, contentType, input.entryId);
    const parent = await loadParent(ctx, entry);
    const values = resolveEffectiveValues(contentType.definition, entry, parent);
    const current = await getCurrentTemplate(ctx, contentType.id);

    const liquid = input.liquid ?? current?.liquid ?? "";
    const css = input.css ?? current?.css ?? "";
    const html = await renderLiquid({
      liquid,
      scope: {
        entry: { id: entry.id, locale: entry.locale, status: entry.status },
        values,
        type: { uid: contentType.uid, name: contentType.name },
      },
      storage: ctx.services.storage,
    });

    // Preview audit (§0.11 WA/SEO): structure checks on the rendered HTML + the entry's
    // SEO advisories, and the head snippet the entry would emit. Contrast runs client-side.
    const checks: AuditFinding[] = auditRenderedHtml(html);
    let head: string | null = null;
    const seoOpts = seoTypeOptions(contentType.options);
    if (seoOpts?.enabled) {
      const seoCtx = {
        seo: entry.seo ?? null,
        typeOptions: seoOpts,
        workspaceSeo: await loadWorkspaceSeo(ctx),
        entry: { id: entry.id, documentId: entry.documentId, locale: entry.locale },
        values,
        displayValue: displayValueOf(contentType.definition, values),
        schemaOrgType: contentType.schemaOrgType,
      };
      head = serializeHeadTags(buildHeadTags(seoCtx));
      for (const a of computePublishAdvisories(seoCtx)) {
        checks.push({ rule: a.code, severity: a.severity, message: a.message });
      }
    }
    for (const a of await computeAltAdvisories(
      ctx.db,
      ctx.workspaceId,
      contentType.definition,
      values,
    )) {
      checks.push({ rule: a.code, severity: a.severity, message: a.message });
    }
    return { html, css, head, checks };
  },
});
