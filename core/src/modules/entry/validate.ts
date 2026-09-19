/**
 * Entry value validation orchestration — schema pipeline (T1.3) + async handler validation (T1.2).
 * Whether input arrives via REST or MCP, it must pass through this function (Appendix A).
 */
import { and, eq, inArray } from "drizzle-orm";
import type { ContentTypeDefinition } from "@prina/shared";
import { assets, contentTypes, entries } from "../../db/schema/index.js";
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
  };
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
