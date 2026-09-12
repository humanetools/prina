/**
 * Value uniqueness enforcement + uid derivation — applies to every save via persistEntryValues (UI, REST, MCP, import).
 * Scope: same workspace, type, and locale. Other-locale entries of the same document are allowed.
 * App-level check assuming a single node (runs inside a transaction) — multi-node is a generated column extension point.
 */
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { FieldType } from "@prina/shared";
import type { FieldDef, RelationFieldDef, UidFieldDef } from "@prina/shared";
import { entries, entryRelations } from "../../db/schema/index.js";
import { ValidationError } from "../../lib/errors.js";
import { slugify } from "../../content/field-types/uid.js";
import { isToMany } from "../../content/field-types/index.js";
import type { CommandCtx } from "../../commands/context.js";
import type { ContentTypeRow } from "../content-type/repo.js";
import type { EntryRow } from "./variants.js";

function uniqueFieldsOf(contentType: ContentTypeRow): FieldDef[] {
  return contentType.definition.fields.filter(
    (f) => f.type === FieldType.Uid || (f as { unique?: boolean }).unique === true,
  );
}

async function valueTaken(
  ctx: CommandCtx,
  contentType: ContentTypeRow,
  entry: EntryRow,
  fieldName: string,
  value: string,
): Promise<boolean> {
  const [dup] = await ctx.db
    .select({ id: entries.id })
    .from(entries)
    .where(
      and(
        eq(entries.workspaceId, ctx.workspaceId),
        eq(entries.contentTypeId, contentType.id),
        eq(entries.locale, entry.locale),
        ne(entries.documentId, entry.documentId),
        sql`${entries.values}->>${fieldName} = ${value}`,
      ),
    )
    .limit(1);
  return !!dup;
}

/** 422 when a unique field's value (uid included) collides with another document */
export async function assertUniqueValues(
  ctx: CommandCtx,
  contentType: ContentTypeRow,
  entry: EntryRow,
  values: Record<string, unknown>,
): Promise<void> {
  const issues: string[] = [];
  for (const field of uniqueFieldsOf(contentType)) {
    const value = values[field.name];
    if (value === null || value === undefined || value === "") continue;
    if (await valueTaken(ctx, contentType, entry, field.name, String(value))) {
      issues.push(`${field.name}: '${String(value)}' is already used by another entry`);
    }
  }
  if (issues.length > 0) {
    throw new ValidationError("Content value validation failed", { issues });
  }
}

/** Rejects the degenerate case of an entry referencing itself via relation (UI excludes it from candidates; guards API/MCP) */
export function assertNoSelfReference(
  contentType: ContentTypeRow,
  entry: EntryRow,
  values: Record<string, unknown>,
): void {
  const issues: string[] = [];
  for (const field of contentType.definition.fields) {
    if (field.type !== FieldType.Relation) continue;
    const value = values[field.name];
    if (value === null || value === undefined) continue;
    const ids = Array.isArray(value) ? (value as string[]) : [value as string];
    if (ids.includes(entry.id)) {
      issues.push(`${field.name}: an entry cannot reference itself`);
    }
  }
  if (issues.length > 0) {
    throw new ValidationError("Content value validation failed", { issues });
  }
}

/**
 * Exclusive relation (oneToOne, oneToMany) enforcement — a target entry may be linked
 * to only one document per type/field/locale. manyToOne and manyToMany share freely.
 */
export async function assertExclusiveRelations(
  ctx: CommandCtx,
  contentType: ContentTypeRow,
  entry: EntryRow,
  values: Record<string, unknown>,
): Promise<void> {
  const exclusiveFields = contentType.definition.fields.filter(
    (f): f is RelationFieldDef =>
      f.type === FieldType.Relation &&
      (f.relationKind === "oneToOne" || f.relationKind === "oneToMany"),
  );
  const issues: string[] = [];
  for (const field of exclusiveFields) {
    const value = values[field.name];
    if (value === null || value === undefined) continue;
    const ids = isToMany(field) ? (value as string[]) : [value as string];
    if (ids.length === 0) continue;

    const taken = await ctx.db
      .select({ toEntryId: entryRelations.toEntryId })
      .from(entryRelations)
      .innerJoin(entries, eq(entryRelations.fromEntryId, entries.id))
      .where(
        and(
          eq(entries.workspaceId, ctx.workspaceId),
          eq(entries.contentTypeId, contentType.id),
          eq(entries.locale, entry.locale),
          ne(entries.documentId, entry.documentId),
          eq(entryRelations.field, field.name),
          inArray(entryRelations.toEntryId, ids),
        ),
      );
    for (const row of taken) {
      issues.push(
        `${field.name}: target ${row.toEntryId} is already linked from another entry (${field.relationKind} is exclusive)`,
      );
    }
  }
  if (issues.length > 0) {
    throw new ValidationError("Content value validation failed", { issues });
  }
}

/**
 * Derives empty uid fields from the targetField value.
 * On collision, -2, -3… suffixes; sources yielding no slug (e.g. Korean) fall back to the entry id's first 8 chars.
 */
export async function deriveUidValues(
  ctx: CommandCtx,
  contentType: ContentTypeRow,
  entry: EntryRow,
  values: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const uidFields = contentType.definition.fields.filter(
    (f): f is UidFieldDef => f.type === FieldType.Uid,
  );
  if (uidFields.length === 0) return values;

  const next = { ...values };
  for (const field of uidFields) {
    const current = next[field.name];
    if (typeof current === "string" && current !== "") continue;
    if (current === "") delete next[field.name];

    const source = field.targetField ? next[field.targetField] : undefined;
    if (typeof source !== "string" || source === "") continue;

    const base = slugify(source) || entry.id.slice(0, 8);
    let candidate = base;
    for (let n = 2; await valueTaken(ctx, contentType, entry, field.name, candidate); n++) {
      candidate = `${base}-${n}`;
    }
    next[field.name] = candidate;
  }
  return next;
}
