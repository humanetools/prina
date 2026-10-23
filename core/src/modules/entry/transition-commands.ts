/**
 * Workflow transition commands (T1.5, skeleton for T2.3) — version viewing/restore is EE (src/ee/versions)
 * [decision] Enforcement of required-field presence happens at the publish transition gate (see schema-compiler).
 * The transition guard (transition×role) is injected in Phase 2 as the services.transitionGuard implementation.
 */
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { EntryStatus, PermissionAction, contentSubject } from "@prina/shared";
import { entries, workflows, workflowTransitions } from "../../db/schema/index.js";
import { defineCommand } from "../../commands/define.js";
import { ValidationError } from "../../lib/errors.js";
import { getContentTypeByUid } from "../content-type/repo.js";
import { computeCompleteness } from "./completeness.js";
import { computeAltAdvisories, computePublishAdvisories } from "./advisories.js";
import { loadWorkspaceSeo } from "./seo.js";
import { displayValueOf, seoTypeOptions } from "../../delivery/seo.js";
import { getEntryScoped, loadParent } from "./save-helpers.js";
import { resolveEffectiveValues } from "./variants.js";
import { recordVersion } from "./versions.js";
import { enqueueEmbedding } from "../delivery/semantic.js";
import { emitEntryEvent, type CommandCtx } from "../../commands/context.js";

const typeUid = z.string().min(1);

/** Whether the workspace's default workflow allows this transition. Allowed when no workflow is set (bootstrap seeds the default preset) */
async function assertTransitionDefined(
  ctx: CommandCtx,
  from: string,
  to: string,
): Promise<void> {
  const [wf] = await ctx.db
    .select({ id: workflows.id })
    .from(workflows)
    .where(and(eq(workflows.workspaceId, ctx.workspaceId), eq(workflows.isDefault, true)))
    .limit(1);
  if (!wf) return;
  const [allowed] = await ctx.db
    .select({ id: workflowTransitions.id })
    .from(workflowTransitions)
    .where(
      and(
        eq(workflowTransitions.workflowId, wf.id),
        eq(workflowTransitions.fromState, from),
        eq(workflowTransitions.toState, to),
      ),
    )
    .limit(1);
  if (!allowed) {
    // Naming the allowed moves turns "why is review blocked but published fine?" into an
    // answerable question: the core workflow is draft↔published, and the submit/approve
    // states come with EE (MCP QA read the bare refusal as a bug, 2026-08-24).
    const rows = await ctx.db
      .select({ from: workflowTransitions.fromState, to: workflowTransitions.toState })
      .from(workflowTransitions)
      .where(eq(workflowTransitions.workflowId, wf.id));
    const all = rows.map((r) => `${r.from} → ${r.to}`).sort();
    const fromHere = rows.filter((r) => r.from === from).map((r) => r.to);
    throw new ValidationError(
      `Transition not allowed: ${from} → ${to}. ` +
        (fromHere.length
          ? `From '${from}' this workflow allows: ${fromHere.join(", ")}.`
          : `This workflow defines no transition out of '${from}'.`),
      { allowedFromCurrentState: fromHere, workflowTransitions: all },
    );
  }
}

export const entryTransition = defineCommand({
  name: "entry.transition",
  resource: "entry",
  input: z.object({
    typeUid,
    id: z.string().uuid(),
    to: z.nativeEnum(EntryStatus),
  }),
  /** publish is a separate action (T2.2) — basis of the "AI up to draft, humans publish" policy */
  permission: (i) => ({
    action:
      i.to === EntryStatus.Published
        ? PermissionAction.Publish
        : PermissionAction.Transition,
    subject: contentSubject(i.typeUid),
  }),
  async execute(input, ctx) {
    const contentType = await getContentTypeByUid(ctx.db, ctx.workspaceId, input.typeUid);
    const entry = await getEntryScoped(ctx, contentType, input.id);
    const from = entry.status;
    if (from === input.to) {
      throw new ValidationError(`Already in '${from}'`);
    }

    await assertTransitionDefined(ctx, from, input.to);
    // A role-based guard implementation is injected in Phase 2 — equally applied to MCP (T6.2)
    await ctx.services.transitionGuard(
      { typeUid: input.typeUid, from, to: input.to },
      ctx,
    );

    if (input.to === EntryStatus.Published) {
      const parent = await loadParent(ctx, entry);
      const effective = resolveEffectiveValues(contentType.definition, entry, parent);
      const completeness = computeCompleteness(
        ctx.services.registry,
        contentType.definition,
        effective,
      );
      if (completeness.missing.length > 0) {
        throw new ValidationError("Cannot publish — required fields are incomplete", {
          missing: completeness.missing,
        });
      }
      // SEO strict mode (§0.11): a type can opt into blocking on error-severity advisories
      const seoOpts = seoTypeOptions(contentType.options);
      if (seoOpts?.enabled && seoOpts.strictPublish) {
        const advisories = [
          ...computePublishAdvisories({
            typeOptions: seoOpts,
            workspaceSeo: await loadWorkspaceSeo(ctx),
            entry: { id: entry.id, documentId: entry.documentId, locale: entry.locale },
            values: effective,
            seo: entry.seo ?? null,
            displayValue: displayValueOf(contentType.definition, effective),
          }),
          ...(await computeAltAdvisories(
            ctx.db,
            ctx.workspaceId,
            contentType.definition,
            effective,
          )),
        ];
        const blocking = advisories.filter((a) => a.severity === "error");
        if (blocking.length > 0) {
          throw new ValidationError("Cannot publish — SEO checks failed", {
            advisories: blocking,
          });
        }
      }
    }

    const [updated] = await ctx.db
      .update(entries)
      .set({
        status: input.to,
        publishedAt: input.to === EntryStatus.Published ? new Date() : entry.publishedAt,
        // A human moving the entry through the workflow counts as review (IMPL-ai-locale-translation)
        aiDraft: null,
        updatedAt: new Date(),
      })
      .where(eq(entries.id, entry.id))
      .returning();
    const version = await recordVersion(ctx, updated!);
    // Publish → re-enqueue semantic embedding (T9.3, no-op without pgvector)
    if (input.to === EntryStatus.Published) {
      await enqueueEmbedding(ctx.db, entry.id, ctx.workspaceId);
    }
    // Entry lifecycle fan-out (EE chatbot knowledge, C0) — errors are logged, never thrown
    if (input.to === EntryStatus.Published || from === EntryStatus.Published) {
      await emitEntryEvent(ctx, {
        kind: input.to === EntryStatus.Published ? "published" : "unpublished",
        entryId: entry.id,
        workspaceId: ctx.workspaceId,
        typeUid: input.typeUid,
        locale: entry.locale,
      });
    }
    return { entry: updated!, version, from, to: input.to };
  },
  resourceId: (i) => i.id,
  auditPayload: (i, o) => ({ typeUid: i.typeUid, from: o.from, to: o.to }),
});
