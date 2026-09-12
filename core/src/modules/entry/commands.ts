/** Entry CRUD commands (T1.4) — shared by UI and MCP. Transition/version commands live in separate files */
import { z } from "zod";
import { and, asc, count, desc, eq, isNull, sql } from "drizzle-orm";
import { FieldType, PermissionAction, contentSubject } from "@prina/shared";
import { entries, entryTaxonomyNodes, taxonomyNodes } from "../../db/schema/index.js";
import { defineCommand } from "../../commands/define.js";
import { ConflictError, ValidationError } from "../../lib/errors.js";
import { getContentTypeByUid } from "../content-type/repo.js";
import { assertLocaleExists } from "../locale/commands.js";
import { assertPermissionInExecute, maskReadableValues } from "../rbac/service.js";
import { computeCompleteness } from "./completeness.js";
import { computeAltAdvisories, computePublishAdvisories } from "./advisories.js";
import { loadWorkspaceSeo } from "./seo.js";
import { displayValueOf, seoTypeOptions } from "../../delivery/seo.js";
import {
  defaultLocale,
  getEntryScoped,
  loadParent,
  persistEntryValues,
} from "./save-helpers.js";
import { resolveEffectiveValues } from "./variants.js";
import { emitEntryEvent } from "../../commands/context.js";

const typeUid = z.string().min(1);
const valuesSchema = z.record(z.unknown());

export const entryCreate = defineCommand({
  name: "entry.create",
  resource: "entry",
  input: z.object({
    typeUid,
    values: valuesSchema.default({}),
    locale: z.string().min(2).max(20).optional(),
    /** Specify when adding another locale's entry to an existing document (§2.3 document-level i18n) */
    documentId: z.string().uuid().optional(),
  }),
  permission: (i) => ({
    action: PermissionAction.Create,
    subject: contentSubject(i.typeUid),
    locale: i.locale,
    fields: Object.keys(i.values),
  }),
  async execute(input, ctx) {
    const contentType = await getContentTypeByUid(ctx.db, ctx.workspaceId, input.typeUid);
    const locale = input.locale ?? (await defaultLocale(ctx));
    await assertLocaleExists(ctx, locale); // T2.4: only registered locales are allowed
    if (!input.locale) {
      // When the default locale was resolved, re-verify locale-dimension permission
      await assertPermissionInExecute(ctx, {
        action: PermissionAction.Create,
        subject: contentSubject(input.typeUid),
        locale,
      });
    }

    if (contentType.kind === "single") {
      const countRows = await ctx.db
        .select({ value: count() })
        .from(entries)
        .where(
          and(
            eq(entries.contentTypeId, contentType.id),
            eq(entries.locale, locale),
            isNull(entries.parentEntryId),
          ),
        );
      if ((countRows[0]?.value ?? 0) > 0) {
        throw new ConflictError(`A single type ('${input.typeUid}') allows only one entry per locale`);
      }
    }
    if (input.documentId) {
      const [dup] = await ctx.db
        .select({ id: entries.id })
        .from(entries)
        .where(and(eq(entries.documentId, input.documentId), eq(entries.locale, locale)))
        .limit(1);
      if (dup) throw new ConflictError(`This document already has a '${locale}' entry`);
    }

    const [created] = await ctx.db
      .insert(entries)
      .values({
        workspaceId: ctx.workspaceId,
        contentTypeId: contentType.id,
        ...(input.documentId ? { documentId: input.documentId } : {}),
        locale,
        values: {},
        createdBy: ctx.actor.type === "human" ? (ctx.actor.id ?? null) : null,
      })
      .returning();

    const saved = await persistEntryValues(ctx, contentType, created!, input.values);
    return saved;
  },
  resourceId: (_i, o) => o.entry.id,
  auditPayload: (i, o) => ({
    typeUid: i.typeUid,
    locale: o.entry.locale,
    documentId: o.entry.documentId,
    variantsDerived: o.variants.created,
  }),
});

export const entryUpdate = defineCommand({
  name: "entry.update",
  resource: "entry",
  input: z.object({
    typeUid,
    id: z.string().uuid(),
    /** Partial patch — merged into existing values. Explicit null clears the field */
    values: valuesSchema,
  }),
  permission: (i) => ({
    action: PermissionAction.Update,
    subject: contentSubject(i.typeUid),
    fields: Object.keys(i.values),
  }),
  async execute(input, ctx) {
    const contentType = await getContentTypeByUid(ctx.db, ctx.workspaceId, input.typeUid);
    const entry = await getEntryScoped(ctx, contentType, input.id);
    // Locale is finalized from the DB, so re-verify locale-dimension permission here (T2.2 locale)
    await assertPermissionInExecute(ctx, {
      action: PermissionAction.Update,
      subject: contentSubject(input.typeUid),
      locale: entry.locale,
      fields: Object.keys(input.values),
    });
    const merged = { ...entry.values, ...input.values };
    return persistEntryValues(ctx, contentType, entry, merged);
  },
  resourceId: (i) => i.id,
  auditPayload: (i, o) => ({
    typeUid: i.typeUid,
    changedFields: Object.keys(i.values),
    variants: o.variants,
  }),
});

export const entryGet = defineCommand({
  name: "entry.get",
  resource: "entry",
  skipAudit: true,
  input: z.object({ typeUid, id: z.string().uuid() }),
  permission: (i) => ({
    action: PermissionAction.Read,
    subject: contentSubject(i.typeUid),
  }),
  async execute(input, ctx) {
    const contentType = await getContentTypeByUid(ctx.db, ctx.workspaceId, input.typeUid);
    const entry = await getEntryScoped(ctx, contentType, input.id);
    const parent = await loadParent(ctx, entry);
    const effectiveValues = resolveEffectiveValues(contentType.definition, entry, parent);
    const completeness = computeCompleteness(
      ctx.services.registry,
      contentType.definition,
      effectiveValues,
    );
    const children = await ctx.db
      .select({
        id: entries.id,
        variantValues: entries.variantValues,
        status: entries.status,
        values: entries.values,
      })
      .from(entries)
      .where(eq(entries.parentEntryId, entry.id))
      .orderBy(asc(entries.createdAt));

    // Taxonomy attach + attribute sets (T2.5)
    const attached = await ctx.db
      .select({
        nodeId: entryTaxonomyNodes.nodeId,
        attributeValues: entryTaxonomyNodes.attributeValues,
        name: taxonomyNodes.name,
        path: taxonomyNodes.path,
        attributeComponentUid: taxonomyNodes.attributeComponentUid,
      })
      .from(entryTaxonomyNodes)
      .innerJoin(taxonomyNodes, eq(entryTaxonomyNodes.nodeId, taxonomyNodes.id))
      .where(eq(entryTaxonomyNodes.entryId, entry.id));

    // Publish-readiness advisories (§0.11): SEO checks when the type opted in + alt checks always
    const seoOpts = seoTypeOptions(contentType.options);
    const advisories = [
      ...(seoOpts?.enabled
        ? computePublishAdvisories({
            typeOptions: seoOpts,
            workspaceSeo: await loadWorkspaceSeo(ctx),
            entry: { id: entry.id, documentId: entry.documentId, locale: entry.locale },
            values: effectiveValues,
            seo: entry.seo ?? null,
            displayValue: displayValueOf(contentType.definition, effectiveValues),
          })
        : []),
      ...(await computeAltAdvisories(
        ctx.db,
        ctx.workspaceId,
        contentType.definition,
        effectiveValues,
      )),
      // Unreviewed AI translation (IMPL-ai-locale-translation) — cleared by any human save/transition
      ...(entry.aiDraft
        ? [
            {
              code: "ai-draft-unreviewed",
              severity: "warn" as const,
              message: `AI-translated draft (from '${entry.aiDraft.sourceLocale}') — review before publishing`,
            },
          ]
        : []),
    ];

    // Response masking (T2.2): strip non-readable fields
    const subject = contentSubject(input.typeUid);
    const maskedEntry = {
      ...entry,
      values: await maskReadableValues(ctx, subject, entry.values, entry.locale),
    };
    return {
      entry: maskedEntry,
      effectiveValues: await maskReadableValues(ctx, subject, effectiveValues, entry.locale),
      completeness,
      advisories,
      /** Child SKU list — values contain only overrides */
      variants: await Promise.all(
        children.map(async (c) => ({
          ...c,
          values: await maskReadableValues(ctx, subject, c.values, entry.locale),
        })),
      ),
      overriddenFields: parent ? Object.keys(entry.values) : null,
      taxonomies: attached,
    };
  },
});

export const entryList = defineCommand({
  name: "entry.list",
  resource: "entry",
  skipAudit: true,
  input: z.object({
    typeUid,
    locale: z.string().optional(),
    status: z.string().optional(),
    /** Full-list text search over search_text (extracted display/body text incl. richtext) */
    search: z.string().max(200).optional(),
    /** values JSONB equality filter: { field: value } */
    filter: z.record(z.string()).optional(),
    includeVariants: z.boolean().default(false),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    /** field:direction — display sorts by the type's displayField value, completeness by score */
    sort: z
      .enum([
        "createdAt:asc", "createdAt:desc",
        "updatedAt:asc", "updatedAt:desc",
        "status:asc", "status:desc",
        "locale:asc", "locale:desc",
        "display:asc", "display:desc",
        "completeness:asc", "completeness:desc",
      ])
      .default("updatedAt:desc"),
  }),
  permission: (i) => ({
    action: PermissionAction.Read,
    subject: contentSubject(i.typeUid),
    locale: i.locale,
  }),
  async execute(input, ctx) {
    const contentType = await getContentTypeByUid(ctx.db, ctx.workspaceId, input.typeUid);
    const conds = [
      eq(entries.workspaceId, ctx.workspaceId),
      eq(entries.contentTypeId, contentType.id),
    ];
    if (input.locale) conds.push(eq(entries.locale, input.locale));
    if (input.status) conds.push(eq(entries.status, input.status));
    if (input.search?.trim()) {
      // ILIKE over search_text — pg_trgm makes this indexable; scope stays one type
      const term = `%${input.search.trim().replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
      conds.push(sql`${entries.searchText} ILIKE ${term}`);
    }
    if (!input.includeVariants) conds.push(isNull(entries.parentEntryId));
    for (const [field, value] of Object.entries(input.filter ?? {})) {
      if (!contentType.definition.fields.some((f) => f.name === field)) {
        throw new ValidationError(`Filter field '${field}' is not in the type definition`);
      }
      conds.push(sql`${entries.values}->>${field} = ${value}`);
    }

    const [sortField, sortDir] = input.sort.split(":") as [string, "asc" | "desc"];
    const dirFn = sortDir === "asc" ? asc : desc;
    let orderBy;
    if (sortField === "display") {
      // Sort by the human title: the type's displayField value (nulls trail either way)
      const df = contentType.definition.displayField ?? contentType.definition.fields[0]?.name ?? "";
      orderBy =
        sortDir === "asc"
          ? sql`${entries.values}->>${df} ASC NULLS LAST`
          : sql`${entries.values}->>${df} DESC NULLS LAST`;
    } else if (sortField === "completeness") {
      orderBy =
        sortDir === "asc"
          ? sql`(${entries.completeness}->>'score')::numeric ASC NULLS LAST`
          : sql`(${entries.completeness}->>'score')::numeric DESC NULLS LAST`;
    } else if (sortField === "status") orderBy = dirFn(entries.status);
    else if (sortField === "locale") orderBy = dirFn(entries.locale);
    else if (sortField === "createdAt") orderBy = dirFn(entries.createdAt);
    else orderBy = dirFn(entries.updatedAt);

    const where = and(...conds);
    const totalRows = await ctx.db
      .select({ value: count() })
      .from(entries)
      .where(where);
    const total = totalRows[0]?.value ?? 0;
    const rows = await ctx.db
      .select()
      .from(entries)
      .where(where)
      // id tiebreaker: bulk imports share created/updated timestamps — without it, rows
      // shuffle between pages on every request
      .orderBy(orderBy, dirFn(entries.id))
      .limit(input.pageSize)
      .offset((input.page - 1) * input.pageSize);

    const subject = contentSubject(input.typeUid);
    const masked = await Promise.all(
      rows.map(async (r) => ({
        ...r,
        values: await maskReadableValues(ctx, subject, r.values, r.locale),
      })),
    );
    return {
      items: masked,
      pagination: {
        page: input.page,
        pageSize: input.pageSize,
        total,
        pageCount: Math.ceil(total / input.pageSize),
      },
    };
  },
});

export const entryDuplicate = defineCommand({
  name: "entry.duplicate",
  resource: "entry",
  input: z.object({ typeUid, id: z.string().uuid() }),
  permission: (i) => ({
    action: PermissionAction.Create,
    subject: contentSubject(i.typeUid),
  }),
  async execute(input, ctx) {
    const contentType = await getContentTypeByUid(ctx.db, ctx.workspaceId, input.typeUid);
    const source = await getEntryScoped(ctx, contentType, input.id);
    if (source.parentEntryId) {
      throw new ValidationError("Variant children cannot be duplicated — duplicate the parent");
    }
    if (contentType.kind === "single") {
      throw new ConflictError(`A single type ('${input.typeUid}') allows only one entry per locale`);
    }

    // The copy avoids uniqueness conflicts: uid is cleared for re-derivation, unique values are cleared
    const values: Record<string, unknown> = { ...source.values };
    for (const field of contentType.definition.fields) {
      const isUid = field.type === FieldType.Uid;
      const isUnique = (field as { unique?: boolean }).unique === true;
      if (isUid || isUnique) delete values[field.name];
    }

    const [created] = await ctx.db
      .insert(entries)
      .values({
        workspaceId: ctx.workspaceId,
        contentTypeId: contentType.id,
        locale: source.locale,
        values: {},
        createdBy: ctx.actor.type === "human" ? (ctx.actor.id ?? null) : null,
      })
      .returning();
    const saved = await persistEntryValues(ctx, contentType, created!, values);
    return saved;
  },
  resourceId: (_i, o) => o.entry.id,
  auditPayload: (i, o) => ({ typeUid: i.typeUid, sourceId: i.id, newId: o.entry.id }),
});

export const entryDelete = defineCommand({
  name: "entry.delete",
  resource: "entry",
  input: z.object({ typeUid, id: z.string().uuid() }),
  permission: (i) => ({
    action: PermissionAction.Delete,
    subject: contentSubject(i.typeUid),
  }),
  async execute(input, ctx) {
    const contentType = await getContentTypeByUid(ctx.db, ctx.workspaceId, input.typeUid);
    const entry = await getEntryScoped(ctx, contentType, input.id);
    await ctx.db.delete(entries).where(eq(entries.id, entry.id));
    // Entry lifecycle fan-out (EE chatbot knowledge, C0) — errors are logged, never thrown
    await emitEntryEvent(ctx, {
      kind: "deleted",
      entryId: entry.id,
      workspaceId: ctx.workspaceId,
      typeUid: input.typeUid,
      locale: entry.locale,
    });
    return { id: entry.id };
  },
  resourceId: (i) => i.id,
  auditPayload: (i) => ({ typeUid: i.typeUid }),
});
