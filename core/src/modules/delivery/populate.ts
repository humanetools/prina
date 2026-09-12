/**
 * delivery ?populate=1 — inline relation/media values in consumable form (T5.2 extension).
 * - relation: published-target summary {id, documentId, locale, display} — draft targets excluded
 * - media: {id, url, filename, mime, width, height, alt} (url = /delivery/assets/:id)
 * Recurses into component/dynamic_zone. Batch fetch then substitute — query count stays fixed
 * even for 100-item lists.
 */
import { and, eq, inArray } from "drizzle-orm";
import { EntryStatus, FieldType } from "@prina/shared";
import type {
  ContentTypeDefinition,
  FieldDef,
  MediaFieldDef,
  RelationFieldDef,
} from "@prina/shared";
import { assets, contentTypes, entries, entryRelations } from "../../db/schema/index.js";
import { isToMany } from "../../content/field-types/index.js";
import { toMediaRefs } from "../../content/field-types/media.js";
import { loadComponentMap } from "../content-type/repo.js";
import type { DeliveryCtx } from "./service.js";

export interface RelSummary {
  id: string;
  documentId: string;
  locale: string;
  /** Target type's displayField value (null if absent) */
  display: unknown;
  /** Target type uid + schema.org mapping (for JSON-LD consumers) */
  type: string;
  schemaOrgType: string | null;
}

interface AssetSummary {
  id: string;
  url: string;
  filename: string;
  mime: string;
  width: number | null;
  height: number | null;
  /** a11y (WCAG 1.1.1) — null = not described yet, "" = decorative */
  alt: string | null;
}

type ComponentMap = Map<string, ContentTypeDefinition>;

function asIds(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? (value as string[]) : [value as string];
}

/** Walks the value tree — collect and transform share the same traversal path */
function walkValues(
  definition: ContentTypeDefinition,
  values: Record<string, unknown>,
  componentMap: ComponentMap,
  visit: {
    relation(def: RelationFieldDef, value: unknown): unknown;
    media(def: MediaFieldDef, value: unknown): unknown;
  },
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...values };
  for (const field of definition.fields) {
    const value = next[field.name];
    if (value === null || value === undefined) continue;
    next[field.name] = walkField(field, value, componentMap, visit);
  }
  return next;
}

function walkField(
  field: FieldDef,
  value: unknown,
  componentMap: ComponentMap,
  visit: Parameters<typeof walkValues>[3],
): unknown {
  switch (field.type) {
    case FieldType.Relation:
      return visit.relation(field, value);
    case FieldType.Media:
      return visit.media(field, value);
    case FieldType.Component: {
      const def = componentMap.get(field.component);
      if (!def) return value;
      if (field.repeatable && Array.isArray(value)) {
        return value.map((v) =>
          walkValues(def, v as Record<string, unknown>, componentMap, visit),
        );
      }
      return walkValues(def, value as Record<string, unknown>, componentMap, visit);
    }
    case FieldType.DynamicZone: {
      if (!Array.isArray(value)) return value;
      return value.map((block) => {
        const b = block as Record<string, unknown>;
        const def = componentMap.get(String(b.__component));
        if (!def) return b;
        return { ...walkValues(def, b, componentMap, visit), __component: b.__component };
      });
    }
    default:
      return value;
  }
}

/**
 * Inverse-edge collection (T9.1 inverse) — among relations pointing at this entry, group
 * writeInverse-enabled fields by inversePredicate and return source-entry summaries.
 */
export async function collectInverseEdges(
  ctx: DeliveryCtx,
  entryId: string,
): Promise<Record<string, RelSummary[]>> {
  const rows = await ctx.db
    .select({
      field: entryRelations.field,
      id: entries.id,
      documentId: entries.documentId,
      locale: entries.locale,
      status: entries.status,
      values: entries.values,
      typeUid: contentTypes.uid,
      schemaOrgType: contentTypes.schemaOrgType,
      typeDefinition: contentTypes.definition,
    })
    .from(entryRelations)
    .innerJoin(entries, eq(entryRelations.fromEntryId, entries.id))
    .innerJoin(contentTypes, eq(entries.contentTypeId, contentTypes.id))
    .where(
      and(
        eq(entryRelations.toEntryId, entryId),
        eq(contentTypes.workspaceId, ctx.workspace.id),
        ...(ctx.includeDraft ? [] : [eq(entries.status, EntryStatus.Published)]),
      ),
    );

  const out: Record<string, RelSummary[]> = {};
  for (const row of rows) {
    const def = row.typeDefinition.fields.find(
      (f) => f.name === row.field && f.type === FieldType.Relation,
    ) as { writeInverse?: boolean; inversePredicate?: string } | undefined;
    if (!def?.writeInverse || !def.inversePredicate) continue;
    const displayField = row.typeDefinition.displayField;
    (out[def.inversePredicate] ??= []).push({
      id: row.id,
      documentId: row.documentId,
      locale: row.locale,
      display: displayField ? ((row.values as Record<string, unknown>)[displayField] ?? null) : null,
      type: row.typeUid,
      schemaOrgType: row.schemaOrgType,
    });
  }
  return out;
}

export async function populateValuesList(
  ctx: DeliveryCtx,
  definition: ContentTypeDefinition,
  valuesList: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  const componentMap = await loadComponentMap(ctx.db, ctx.workspace.id);

  // 1) Collect — relations grouped by target type, assets as one batch
  const relIdsByTarget = new Map<string, Set<string>>();
  const assetIds = new Set<string>();
  const collect = {
    relation(def: RelationFieldDef, value: unknown) {
      const set = relIdsByTarget.get(def.target) ?? new Set<string>();
      asIds(value).forEach((id) => set.add(id));
      relIdsByTarget.set(def.target, set);
      return value;
    },
    media(def: MediaFieldDef, value: unknown) {
      toMediaRefs(def, value).forEach((r) => assetIds.add(r.id));
      return value;
    },
  };
  for (const values of valuesList) walkValues(definition, values, componentMap, collect);

  // 2) Batch fetch
  const relMap = new Map<string, RelSummary>();
  for (const [targetUid, ids] of relIdsByTarget) {
    if (ids.size === 0) continue;
    const rows = await ctx.db
      .select({
        id: entries.id,
        documentId: entries.documentId,
        locale: entries.locale,
        values: entries.values,
        typeDefinition: contentTypes.definition,
        typeUid: contentTypes.uid,
        schemaOrgType: contentTypes.schemaOrgType,
      })
      .from(entries)
      .innerJoin(contentTypes, eq(entries.contentTypeId, contentTypes.id))
      .where(
        and(
          eq(contentTypes.workspaceId, ctx.workspace.id),
          eq(contentTypes.uid, targetUid),
          inArray(entries.id, [...ids]),
          // populate serves published targets only — draft refs would be broken links for consumers
          ...(ctx.includeDraft ? [] : [eq(entries.status, EntryStatus.Published)]),
        ),
      );
    for (const row of rows) {
      const displayField = row.typeDefinition.displayField;
      relMap.set(row.id, {
        id: row.id,
        documentId: row.documentId,
        locale: row.locale,
        display: displayField ? ((row.values as Record<string, unknown>)[displayField] ?? null) : null,
        type: row.typeUid,
        schemaOrgType: row.schemaOrgType,
      });
    }
  }

  const assetMap = new Map<string, AssetSummary>();
  if (assetIds.size > 0) {
    const rows = await ctx.db
      .select()
      .from(assets)
      .where(and(eq(assets.workspaceId, ctx.workspace.id), inArray(assets.id, [...assetIds])));
    for (const a of rows) {
      assetMap.set(a.id, {
        id: a.id,
        url: `/delivery/assets/${a.id}`,
        filename: a.filename,
        mime: a.mime,
        width: a.width,
        height: a.height,
        alt: a.alt,
      });
    }
  }

  // 3) Substitute — unfetched targets (unpublished/deleted) drop from arrays, singular becomes null
  const transform = {
    relation(def: RelationFieldDef, value: unknown) {
      const summaries = asIds(value)
        .map((id) => relMap.get(id))
        .filter((s): s is RelSummary => !!s);
      return isToMany(def) ? summaries : (summaries[0] ?? null);
    },
    media(def: MediaFieldDef, value: unknown) {
      // §0.12 two-level alt: a usage-level override (incl. "" decorative) beats the asset alt
      const summaries = toMediaRefs(def, value)
        .map((r) => {
          const summary = assetMap.get(r.id);
          if (!summary) return null;
          return r.alt === null || r.alt === undefined
            ? summary
            : { ...summary, alt: r.alt };
        })
        .filter((s): s is AssetSummary => !!s);
      return def.multiple ? summaries : (summaries[0] ?? null);
    },
  };
  return valuesList.map((values) => walkValues(definition, values, componentMap, transform));
}
