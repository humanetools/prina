/**
 * Entry value validation orchestration — schema pipeline (T1.3) + async handler validation (T1.2).
 * Whether input arrives via REST or MCP, it must pass through this function (Appendix A).
 */
import { and, eq, inArray } from "drizzle-orm";
import { FieldType } from "@prina/shared";
import type { ContentTypeDefinition, FieldDef, TaxonomyFieldDef } from "@prina/shared";
import { assets, contentTypes, entries, taxonomies, taxonomyNodes } from "../../db/schema/index.js";
import { ValidationError } from "../../lib/errors.js";
import type { ValueValidationCtx } from "../../content/field-types/registry.js";
import { assertValuesAgainstSchema } from "../../content/schema-compiler.js";
import type { CommandCtx } from "../../commands/context.js";
import type { ContentTypeRow } from "../content-type/repo.js";
import { loadComponentMap } from "../content-type/repo.js";

function makeValueValidationCtx(ctx: CommandCtx): ValueValidationCtx {
  return {
    workspaceId: ctx.workspaceId,
    async findExistingEntryIds(targetTypeUid, ids) {
      if (ids.length === 0) return new Set();
      const rows = await ctx.db
        .select({ id: entries.id })
        .from(entries)
        .innerJoin(contentTypes, eq(entries.contentTypeId, contentTypes.id))
        .where(
          and(
            eq(entries.workspaceId, ctx.workspaceId),
            eq(contentTypes.uid, targetTypeUid),
            inArray(entries.id, ids),
          ),
        );
      return new Set(rows.map((r) => r.id));
    },
    async findExistingAssetIds(ids) {
      if (ids.length === 0) return new Set();
      const rows = await ctx.db
        .select({ id: assets.id })
        .from(assets)
        .where(and(eq(assets.workspaceId, ctx.workspaceId), inArray(assets.id, ids)));
      return new Set(rows.map((r) => r.id));
    },
    async findExistingTaxonomyNodeIds(taxonomyUid, ids) {
      if (ids.length === 0) return new Set();
      const rows = await ctx.db
        .select({ id: taxonomyNodes.id })
        .from(taxonomyNodes)
        .innerJoin(taxonomies, eq(taxonomyNodes.taxonomyId, taxonomies.id))
        .where(
          and(
            eq(taxonomies.workspaceId, ctx.workspaceId),
            eq(taxonomies.uid, taxonomyUid),
            inArray(taxonomyNodes.id, ids),
          ),
        );
      return new Set(rows.map((r) => r.id));
    },
  };
}

/**
 * Taxonomy fields live mostly inside components (menu blocks, card lists), where the top-level pass
 * below does not reach. Collect every (def, value) pair under components / dynamic zones so the node
 * ids get the same existence check as a top-level field (44-IMPL).
 */
function collectNestedTaxonomyValues(
  fields: FieldDef[],
  values: Record<string, unknown>,
  componentMap: Map<string, ContentTypeDefinition>,
  out: Array<{ def: TaxonomyFieldDef; value: unknown }>,
  depth = 0,
): void {
  if (depth > 8) return;
  for (const field of fields) {
    const value = values[field.name];
    if (value === null || value === undefined) continue;
    if (field.type === FieldType.Taxonomy && depth > 0) out.push({ def: field as TaxonomyFieldDef, value });
    else if (field.type === FieldType.Component) {
      const def = componentMap.get(field.component);
      if (!def) continue;
      const list = field.repeatable && Array.isArray(value) ? value : [value];
      for (const v of list) if (v && typeof v === "object") collectNestedTaxonomyValues(def.fields, v as Record<string, unknown>, componentMap, out, depth + 1);
    } else if (field.type === FieldType.DynamicZone && Array.isArray(value)) {
      for (const block of value) {
        const b = block as Record<string, unknown>;
        const def = componentMap.get(String(b.__component));
        if (def) collectNestedTaxonomyValues(def.fields, b, componentMap, out, depth + 1);
      }
    }
  }
}

/** JSON Schema validation + field handler validation. ValidationError on failure */
export async function validateEntryValues(
  ctx: CommandCtx,
  contentType: ContentTypeRow,
  values: Record<string, unknown>,
): Promise<void> {
  const componentMap = await loadComponentMap(ctx.db, ctx.workspaceId);
  const compiled = ctx.services.schemas.getOrCompile(
    ctx.workspaceId,
    contentType.id,
    contentType.version,
    contentType.definition,
    (uid) => componentMap.get(uid),
  );
  assertValuesAgainstSchema(compiled, values);

  const vctx = makeValueValidationCtx(ctx);
  const issues: string[] = [];
  for (const field of contentType.definition.fields) {
    const handler = ctx.services.registry.get(field.type);
    if (!handler.validateValue) continue;
    issues.push(...(await handler.validateValue(field as never, values[field.name], vctx)));
  }
  const nested: Array<{ def: TaxonomyFieldDef; value: unknown }> = [];
  collectNestedTaxonomyValues(contentType.definition.fields, values, componentMap, nested);
  const taxonomyHandler = ctx.services.registry.get(FieldType.Taxonomy);
  for (const { def, value } of nested) {
    issues.push(...(await taxonomyHandler.validateValue!(def as never, value, vctx)));
  }
  if (issues.length > 0) {
    throw new ValidationError("Content value validation failed", { issues });
  }
}

/** Text extraction for search indexing (T1.8) — stored in entries.search_text */
export function buildSearchText(
  ctx: CommandCtx,
  definition: ContentTypeDefinition,
  values: Record<string, unknown>,
): string {
  const parts: string[] = [];
  for (const field of definition.fields) {
    const handler = ctx.services.registry.get(field.type);
    if (!handler.extractText) continue;
    const text = handler.extractText(field as never, values[field.name]);
    if (text) parts.push(text);
  }
  return parts.join("\n").slice(0, 100_000);
}
