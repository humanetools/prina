/**
 * AI locale translation (IMPL-ai-locale-translation) — writes a draft sibling entry for one
 * target locale; publishing stays a human action ("AI up to draft, humans publish").
 * One locale per call: the LLM roundtrip runs inside the command transaction (same precedent
 * as ai.schema_propose), so the admin fans out per locale and failures stay isolated.
 */
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { PermissionAction, contentSubject } from "@prina/shared";
import type { ContentTypeDefinition, EntryAiDraft } from "@prina/shared";
import { components, entries, entryTaxonomyNodes } from "../../db/schema/index.js";
import { defineCommand } from "../../commands/define.js";
import { AppError, ConflictError, ValidationError } from "../../lib/errors.js";
import { getContentTypeByUid } from "../content-type/repo.js";
import { assertLocaleExists } from "../locale/commands.js";
import { getEntryScoped, persistEntryValues } from "../entry/save-helpers.js";
import { DEFAULT_MODELS } from "./llm.js";
import { createLlmRouter, getAiSettings } from "./routing.js";
import {
  applySegments,
  applySeoSegments,
  clampSegments,
  collectSegments,
  translationSystemPrompt,
  type TextSegments,
} from "./translate.js";

export const entryAiTranslate = defineCommand({
  name: "entry.ai_translate",
  resource: "entry",
  input: z.object({
    typeUid: z.string().min(1),
    sourceEntryId: z.string().uuid(),
    targetLocale: z.string().min(2).max(20),
    /** Explicit leaf selection (index-free logical paths, e.g. "seo.meta_title") — from the
     * translate dialog. Omitted = server default (localized-flag rule / all text). */
    fields: z.array(z.string().min(1).max(200)).max(300).optional(),
    /** Translate the entries.seo record texts (default true) */
    includeSeo: z.boolean().optional(),
  }),
  permission: (i) => ({
    action: PermissionAction.Create,
    subject: contentSubject(i.typeUid),
    locale: i.targetLocale,
  }),
  async execute(input, ctx) {
    const contentType = await getContentTypeByUid(ctx.db, ctx.workspaceId, input.typeUid);
    const source = await getEntryScoped(ctx, contentType, input.sourceEntryId);
    if (source.parentEntryId) {
      throw new ValidationError("Variant children follow their parent — translate the parent entry");
    }
    if (source.locale === input.targetLocale) {
      throw new ValidationError(`The source entry already is '${input.targetLocale}'`);
    }
    await assertLocaleExists(ctx, input.targetLocale);
    const [dup] = await ctx.db
      .select({ id: entries.id })
      .from(entries)
      .where(
        and(
          eq(entries.documentId, source.documentId),
          eq(entries.locale, input.targetLocale),
        ),
      )
      .limit(1);
    if (dup) {
      // v1 never overwrites an existing locale (decision ③) — the human owns what exists
      throw new ConflictError(`This document already has a '${input.targetLocale}' entry`);
    }

    let llm = ctx.services.llm;
    const settings = await getAiSettings(ctx.db);
    if (!llm) {
      if (!settings) {
        throw new AppError(
          "AI_NOT_CONFIGURED",
          "AI is not configured — add an API key (BYOK) in Settings › AI",
          400,
        );
      }
      llm = (await createLlmRouter(ctx.db))!; // chain failover (11-IMPL)
    }

    // Component/dynamic-zone values carry nested text — walk them via their definitions
    const componentRows = await ctx.db
      .select({ uid: components.uid, definition: components.definition })
      .from(components)
      .where(eq(components.workspaceId, ctx.workspaceId));
    const componentDefs = new Map(componentRows.map((c) => [c.uid, c.definition]));
    const resolveComponent = (uid: string) =>
      (componentDefs.get(uid) as ContentTypeDefinition | undefined) ?? null;

    const include = input.fields ? new Set(input.fields) : undefined;
    const includeSeo = input.includeSeo !== false;
    const { segments, limits, fields } = collectSegments(
      contentType.definition,
      source.values,
      source.seo ?? null,
      resolveComponent,
      include,
      includeSeo,
    );
    const issues: string[] = [];
    let translated: TextSegments = {};
    if (Object.keys(segments).length > 0) {
      const raw = await llm({
        system: translationSystemPrompt(source.locale, input.targetLocale, limits),
        user: JSON.stringify(segments),
        maxTokens: 8192,
      });
      const jsonText = raw.replace(/^```(json)?\s*/m, "").replace(/```\s*$/m, "").trim();
      try {
        const parsed = JSON.parse(jsonText) as Record<string, unknown>;
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === "string" && k in segments) translated[k] = v;
        }
      } catch {
        throw new ValidationError("Could not parse the AI translation — try again", {
          raw: raw.slice(0, 500),
        });
      }
      for (const k of Object.keys(segments)) {
        if (!(k in translated)) issues.push(`Untranslated segment kept as source: ${k}`);
      }
      // Hard schema limits: an overlong translation would fail validation wholesale (observed
      // with Spanish expanding past a 240-char maxLength) — trim and surface for review
      const clampResult = clampSegments(translated, limits);
      translated = clampResult.clamped;
      issues.push(...clampResult.issues);
    }

    const values = applySegments(
      contentType.definition,
      source.values,
      translated,
      resolveComponent,
      include,
    );
    const seo = includeSeo
      ? applySeoSegments(source.seo ?? null, translated)
      : (source.seo ?? null);

    const [created] = await ctx.db
      .insert(entries)
      .values({
        workspaceId: ctx.workspaceId,
        contentTypeId: contentType.id,
        documentId: source.documentId,
        locale: input.targetLocale,
        values: {},
        seo,
        createdBy: ctx.actor.type === "human" ? (ctx.actor.id ?? null) : null,
      })
      .returning();
    const saved = await persistEntryValues(ctx, contentType, created!, values);

    // Taxonomy attachments are locale-independent classification — carry them to the sibling
    const attachments = await ctx.db
      .select({
        nodeId: entryTaxonomyNodes.nodeId,
        attributeValues: entryTaxonomyNodes.attributeValues,
      })
      .from(entryTaxonomyNodes)
      .where(eq(entryTaxonomyNodes.entryId, source.id));
    if (attachments.length > 0) {
      await ctx.db.insert(entryTaxonomyNodes).values(
        attachments.map((a) => ({
          workspaceId: ctx.workspaceId,
          entryId: saved.entry.id,
          nodeId: a.nodeId,
          attributeValues: a.attributeValues,
        })),
      );
    }

    // persistEntryValues clears ai_draft (a human save = reviewed) — stamp provenance after it
    const aiDraft: EntryAiDraft = {
      kind: "translation",
      sourceEntryId: source.id,
      sourceLocale: source.locale,
      model: settings?.model ?? DEFAULT_MODELS.anthropic,
      createdAt: new Date().toISOString(),
      fields,
    };
    const [stamped] = await ctx.db
      .update(entries)
      .set({ aiDraft })
      .where(eq(entries.id, saved.entry.id))
      .returning();

    return {
      entry: stamped!,
      translatedFields: fields,
      segmentCount: Object.keys(segments).length,
      issues,
    };
  },
  resourceId: (_i, o) => o.entry.id,
  auditPayload: (i, o) => ({
    typeUid: i.typeUid,
    sourceEntryId: i.sourceEntryId,
    targetLocale: i.targetLocale,
    model: o.entry.aiDraft?.model,
    segmentCount: o.segmentCount,
    issueCount: o.issues.length,
  }),
});
