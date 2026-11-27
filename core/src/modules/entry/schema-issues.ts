/**
 * Entries that no longer fit their schema (56-IMPL).
 *
 * A schema change never rewrites entries. Instead an entry whose stored values fail the current schema
 * "needs fixing": it shows what to fix, it cannot be published until it is fixed, and — when the schema
 * change is saved — its published version is taken back to draft. "Needs fixing" is computed from the
 * values and the schema every time; nothing is stored, so it cannot go stale.
 *
 * Values of a field that was removed from the definition are not a problem to fix: they are dropped at the
 * next save (stale keys), at the top level and inside components alike.
 */
import { and, eq, inArray } from "drizzle-orm";
import { ActorType, DYNAMIC_ZONE_BLOCK_ID, EntryStatus, FieldType } from "@prina/shared";
import type { ContentTypeDefinition, FieldDef } from "@prina/shared";
import { auditLog, contentTypes, entries } from "../../db/schema/index.js";
import type { CompiledSchema } from "../../content/schema-compiler.js";
import type { CommandCtx } from "../../commands/context.js";
import { emitEntryEvent } from "../../commands/context.js";
import { AppError } from "../../lib/errors.js";
import type { ContentTypeRow } from "../content-type/repo.js";
import { loadComponentMap } from "../content-type/repo.js";
import { referenceIssues } from "./validate.js";

type ComponentMap = Map<string, ContentTypeDefinition>;
type Obj = Record<string, unknown>;
const MAX_DEPTH = 8;
const isObject = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);

export interface SchemaIssue {
  /** Top-level field the problem sits in */
  field: string;
  /** Where exactly, dotted (`blocks.0.title`) */
  path: string;
  message: string;
}

// ── Stale keys ──────────────────────────────────────────────────

/** Keys a block always carries that are not fields of its component */
const BLOCK_KEYS = new Set(["__component", DYNAMIC_ZONE_BLOCK_ID]);

/**
 * A copy of `values` without keys the definition does not know — at the top level and inside component
 * and dynamic-zone values. With `stored`, a key is dropped only where the stored values carry the same key
 * at the same place: what was left behind by a removed field goes, a key a caller invents is still refused
 * by validation. Without `stored`, every unknown key goes (reading, analysing).
 */
export function stripStaleKeys(definition: ContentTypeDefinition, values: Obj, componentMap: ComponentMap, stored?: Obj | null): Obj {
  const walk = (def: ContentTypeDefinition, obj: Obj, old: Obj | null | undefined, depth: number, block: boolean): Obj => {
    const known = new Map((def.fields as FieldDef[]).map((f) => [f.name, f]));
    const out: Obj = {};
    for (const [key, value] of Object.entries(obj)) {
      const field = known.get(key);
      if (!field) {
        if (block && BLOCK_KEYS.has(key)) out[key] = value;
        // unknown key: stale if it was already stored there (or when no stored copy was given)
        else if (stored !== undefined && !(old && key in old)) out[key] = value;
        continue;
      }
      out[key] = depth >= MAX_DEPTH ? value : nested(field, value, old?.[key], depth);
    }
    return out;
  };
  const nested = (field: FieldDef, value: unknown, old: unknown, depth: number): unknown => {
    if (field.type === FieldType.Component) {
      const comp = componentMap.get(field.component);
      if (!comp) return value;
      if (Array.isArray(value)) {
        return value.map((item, i) => (isObject(item) ? walk(comp, item, Array.isArray(old) && isObject(old[i]) ? old[i] : isObject(old) ? old : null, depth + 1, false) : item));
      }
      return isObject(value) ? walk(comp, value, isObject(old) ? old : Array.isArray(old) && isObject(old[0]) ? old[0] : null, depth + 1, false) : value;
    }
    if (field.type === FieldType.DynamicZone && Array.isArray(value)) {
      const oldBlocks = Array.isArray(old) ? old.filter(isObject) : [];
      return value.map((block, i) => {
        if (!isObject(block)) return block;
        const comp = componentMap.get(String(block.__component));
        if (!comp) return block;
        // the same block: by its stable id when both sides have one, else by position
        const id = block[DYNAMIC_ZONE_BLOCK_ID];
        const before = (id !== undefined && oldBlocks.find((b) => b[DYNAMIC_ZONE_BLOCK_ID] === id)) || oldBlocks[i] || null;
        return walk(comp, block, before, depth + 1, true);
      });
    }
    return value;
  };
  return walk(definition, values, stored, 0, false);
}

// ── Issues ──────────────────────────────────────────────────────

/** Ajv reports every branch of "this shape or null" — the null branch and the wrapper lines are noise */
function ajvIssues(compiled: CompiledSchema, values: Obj): SchemaIssue[] {
  if (compiled.validate(values)) return [];
  const byPath = new Map<string, SchemaIssue>();
  for (const e of compiled.validate.errors ?? []) {
    const message = e.message ?? "invalid";
    if (message === "must be null" || message.startsWith("must match a schema in anyOf")) continue;
    const path = e.instancePath.replace(/^\//, "").replace(/\//g, ".") || "(root)";
    const field = path === "(root)" ? String((e.params as { additionalProperty?: string }).additionalProperty ?? "(root)") : path.split(".")[0]!;
    // the outermost message per place is the one a person can act on
    if (!byPath.has(path)) byPath.set(path, { field, path, message: e.keyword === "additionalProperties" ? `${message}: ${String((e.params as { additionalProperty?: string }).additionalProperty)}` : message });
  }
  // a parent line ("must match exactly one schema") says nothing its children do not say better
  const issues = [...byPath.values()];
  return issues.filter((i) => !(i.message.startsWith("must match exactly one schema") && issues.some((o) => o !== i && o.path.startsWith(`${i.path}.`))));
}

export interface IssueOptions {
  /** Judge against this definition instead of the stored one (a schema change being weighed) */
  definition?: ContentTypeDefinition;
  compiled?: CompiledSchema;
  componentMap?: ComponentMap;
  /** Also check that referenced entries, assets and taxonomy nodes exist. Default true. */
  references?: boolean | Set<string>;
}

/** What is wrong with these values under the type's schema — empty when the entry fits */
export async function schemaIssuesOf(ctx: CommandCtx, contentType: ContentTypeRow, values: Obj, opts: IssueOptions = {}): Promise<SchemaIssue[]> {
  const componentMap = opts.componentMap ?? (await loadComponentMap(ctx.db, ctx.workspaceId));
  const definition = opts.definition ?? contentType.definition;
  const compiled =
    opts.compiled ??
    (opts.definition
      ? ctx.services.schemas.compileUncached(definition, (uid) => componentMap.get(uid))
      : ctx.services.schemas.getOrCompile(ctx.workspaceId, contentType.id, contentType.version, definition, (uid) => componentMap.get(uid)));
  const clean = stripStaleKeys(definition, values, componentMap);
  const issues = ajvIssues(compiled, clean);
  if (opts.references === false) return issues;

  // Reference checks only on fields whose shape is right — the handlers assume it
  const broken = new Set(issues.map((i) => i.field));
  const only = opts.references instanceof Set ? opts.references : null;
  const eligible = new Set(
    (definition.fields as FieldDef[]).map((f) => f.name).filter((name) => !broken.has(name) && (!only || only.has(name))),
  );
  if (eligible.size === 0) return issues;
  for (const line of await referenceIssues(ctx, definition, clean, componentMap, eligible)) {
    const field = line.split(":")[0]!.trim();
    issues.push({ field, path: field, message: line.slice(line.indexOf(":") + 1).trim() });
  }
  return issues;
}

// ── Weighing a schema change ────────────────────────────────────

export interface SchemaChangeImpact {
  /** Entries that fit the schema today and will not fit the new one */
  affected: number;
  /** Of those, how many are published — they are taken back to draft when the change is saved */
  published: number;
  byField: Record<string, number>;
  types: Array<{ uid: string; name: string; affected: number; published: number }>;
  sample: Array<{ id: string; typeUid: string; status: string; fields: string[] }>;
  /** ids of the published entries to take back (not sent to clients) */
  publishedIds: string[];
}

const BATCH = 500;

/** Does this definition use the component, directly or through other components? */
function usesComponent(def: ContentTypeDefinition, uid: string, componentMap: ComponentMap, seen = new Set<string>()): boolean {
  for (const field of def.fields as FieldDef[]) {
    const inner = field.type === FieldType.Component ? [field.component] : field.type === FieldType.DynamicZone ? field.components : [];
    for (const c of inner) {
      if (c === uid) return true;
      if (seen.has(c)) continue;
      seen.add(c);
      const d = componentMap.get(c);
      if (d && usesComponent(d, uid, componentMap, seen)) return true;
    }
  }
  return false;
}

/** Top-level fields whose reference target changed — their stored ids point somewhere else now */
function retargetedFields(before: ContentTypeDefinition, after: ContentTypeDefinition): Set<string> {
  const old = new Map((before.fields as FieldDef[]).map((f) => [f.name, f]));
  const out = new Set<string>();
  for (const f of after.fields as FieldDef[]) {
    const o = old.get(f.name);
    if (!o || o.type !== f.type) continue;
    if (f.type === FieldType.Relation && o.type === FieldType.Relation && o.target !== f.target) out.add(f.name);
    if (f.type === FieldType.Taxonomy && o.type === FieldType.Taxonomy && o.taxonomy !== f.taxonomy) out.add(f.name);
  }
  return out;
}

/**
 * Which entries a new definition breaks. Pass `type` for a content-type change, `component` for a change
 * to a component definition (every type that uses it, at any depth, is looked at).
 * An entry already broken by an earlier change is not counted again — only what this change newly breaks.
 */
export async function analyzeSchemaChange(
  ctx: CommandCtx,
  change: { type: ContentTypeRow; definition: ContentTypeDefinition } | { componentUid: string; definition: ContentTypeDefinition },
): Promise<SchemaChangeImpact> {
  const currentMap = await loadComponentMap(ctx.db, ctx.workspaceId);
  const nextMap = new Map(currentMap);
  let targets: Array<{ row: ContentTypeRow; next: ContentTypeDefinition }>;
  if ("type" in change) {
    targets = [{ row: change.type, next: change.definition }];
  } else {
    nextMap.set(change.componentUid, change.definition);
    const all = await ctx.db.select().from(contentTypes).where(eq(contentTypes.workspaceId, ctx.workspaceId));
    targets = all.filter((t) => usesComponent(t.definition, change.componentUid, currentMap)).map((row) => ({ row, next: row.definition }));
  }

  const impact: SchemaChangeImpact = { affected: 0, published: 0, byField: {}, types: [], sample: [], publishedIds: [] };
  for (const { row, next } of targets) {
    const before = ctx.services.schemas.compileUncached(row.definition, (uid) => currentMap.get(uid));
    const after = ctx.services.schemas.compileUncached(next, (uid) => nextMap.get(uid));
    const retargeted = "type" in change ? retargetedFields(row.definition, next) : new Set<string>();
    const perType = { uid: row.uid, name: row.name, affected: 0, published: 0 };
    for (let offset = 0; ; offset += BATCH) {
      const batch = await ctx.db
        .select({ id: entries.id, status: entries.status, values: entries.values })
        .from(entries)
        .where(and(eq(entries.workspaceId, ctx.workspaceId), eq(entries.contentTypeId, row.id)))
        .orderBy(entries.id)
        .limit(BATCH)
        .offset(offset);
      for (const e of batch) {
        const values = (e.values ?? {}) as Obj;
        const now = await schemaIssuesOf(ctx, row, values, { definition: next, compiled: after, componentMap: nextMap, references: retargeted.size ? retargeted : false });
        if (now.length === 0) continue;
        const was = new Set((await schemaIssuesOf(ctx, row, values, { definition: row.definition, compiled: before, componentMap: currentMap, references: false })).map((i) => i.field));
        const fresh = [...new Set(now.map((i) => i.field))].filter((f) => !was.has(f));
        if (fresh.length === 0) continue;
        perType.affected++;
        for (const f of fresh) impact.byField[f] = (impact.byField[f] ?? 0) + 1;
        if (e.status === EntryStatus.Published) {
          perType.published++;
          impact.publishedIds.push(e.id);
        }
        if (impact.sample.length < 5) impact.sample.push({ id: e.id, typeUid: row.uid, status: e.status, fields: fresh });
      }
      if (batch.length < BATCH) break;
    }
    if (perType.affected > 0) impact.types.push(perType);
    impact.affected += perType.affected;
    impact.published += perType.published;
  }
  return impact;
}

/** What a client is told (no id lists) */
export const impactSummary = ({ publishedIds: _ids, ...rest }: SchemaChangeImpact) => rest;

/** 409 — the change breaks entries and was not confirmed */
export function confirmationRequired(impact: SchemaChangeImpact): AppError {
  const taken = impact.published > 0 ? ` ${impact.published} published ${impact.published === 1 ? "entry" : "entries"} will be taken back to draft (off the site) until fixed.` : "";
  return new AppError(
    "SCHEMA_CHANGE_NEEDS_CONFIRMATION",
    `This change leaves ${impact.affected} ${impact.affected === 1 ? "entry" : "entries"} needing a fix.${taken} Send confirm: true to go ahead.`,
    409,
    impactSummary(impact),
  );
}

/** Takes the published entries a schema change broke back to draft — each with its own audit row */
export async function demoteBrokenEntries(ctx: CommandCtx, impact: SchemaChangeImpact, cause: { kind: "content_type" | "component"; uid: string }): Promise<number> {
  if (impact.publishedIds.length === 0) return 0;
  const rows = await ctx.db
    .update(entries)
    // updatedAt is left alone: it is "last saved", which the new-field notice compares against
    .set({ status: EntryStatus.Draft })
    .where(and(eq(entries.workspaceId, ctx.workspaceId), inArray(entries.id, impact.publishedIds), eq(entries.status, EntryStatus.Published)))
    .returning({ id: entries.id, contentTypeId: entries.contentTypeId, locale: entries.locale });
  if (rows.length === 0) return 0;
  const types = await ctx.db.select({ id: contentTypes.id, uid: contentTypes.uid }).from(contentTypes).where(eq(contentTypes.workspaceId, ctx.workspaceId));
  const uidOf = new Map(types.map((t) => [t.id, t.uid]));
  await ctx.db.insert(auditLog).values(
    rows.map((r) => ({
      workspaceId: ctx.workspaceId,
      actorType: ctx.actor.type ?? ActorType.System,
      actorId: ctx.actor.id ?? null,
      actorLabel: ctx.actor.label ?? null,
      action: "entry.unpublished_by_schema_change",
      resourceType: "entry",
      resourceId: r.id,
      payload: { typeUid: uidOf.get(r.contentTypeId) ?? null, from: EntryStatus.Published, to: EntryStatus.Draft, cause },
    })),
  );
  for (const r of rows) {
    await emitEntryEvent(ctx, { kind: "unpublished", entryId: r.id, workspaceId: ctx.workspaceId, typeUid: uidOf.get(r.contentTypeId) ?? "", locale: r.locale });
  }
  return rows.length;
}

// ── Removed fields: what is still stored ────────────────────────

export interface RemovedFieldValue {
  /** Dotted path of the leftover key (`title`, `hero.subtitle`, `blocks.0.note`) */
  path: string;
  value: unknown;
}

/**
 * Values still stored under keys the definition no longer has — a field removed from the type or from a
 * component. They stay until someone confirms their removal on the entry (entry.update dropRemovedFields).
 */
export function findRemovedFieldValues(definition: ContentTypeDefinition, values: Obj, componentMap: ComponentMap): RemovedFieldValue[] {
  const out: RemovedFieldValue[] = [];
  const walk = (def: ContentTypeDefinition, obj: Obj, prefix: string, depth: number, block: boolean): void => {
    const known = new Map((def.fields as FieldDef[]).map((f) => [f.name, f]));
    for (const [key, value] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${key}` : key;
      const field = known.get(key);
      if (!field) {
        if (!(block && BLOCK_KEYS.has(key))) out.push({ path, value });
        continue;
      }
      if (depth >= MAX_DEPTH) continue;
      if (field.type === FieldType.Component) {
        const comp = componentMap.get(field.component);
        if (!comp) continue;
        if (Array.isArray(value)) value.forEach((item, i) => isObject(item) && walk(comp, item, `${path}.${i}`, depth + 1, false));
        else if (isObject(value)) walk(comp, value, path, depth + 1, false);
      } else if (field.type === FieldType.DynamicZone && Array.isArray(value)) {
        value.forEach((b, i) => {
          if (!isObject(b)) return;
          const comp = componentMap.get(String(b.__component));
          if (comp) walk(comp, b, `${path}.${i}`, depth + 1, true);
        });
      }
    }
  };
  walk(definition, values, "", 0, false);
  return out;
}

// ── Renamed fields: the values move with the name ───────────────

export type FieldRenames = Record<string, string>;

/** A rename map must describe exactly what the two definitions show */
export function assertRenames(before: ContentTypeDefinition, after: ContentTypeDefinition, renames: FieldRenames): void {
  const old = new Set((before.fields as FieldDef[]).map((f) => f.name));
  const next = new Set((after.fields as FieldDef[]).map((f) => f.name));
  const issues: string[] = [];
  for (const [from, to] of Object.entries(renames)) {
    if (from === to) issues.push(`renames.${from}: the new name is the same`);
    else if (!old.has(from)) issues.push(`renames.${from}: there was no field '${from}'`);
    else if (next.has(from)) issues.push(`renames.${from}: '${from}' is still in the definition — a renamed field leaves its old name`);
    else if (!next.has(to)) issues.push(`renames.${from}: the definition has no field '${to}'`);
    else if (old.has(to)) issues.push(`renames.${from}: '${to}' already existed — its values would be overwritten`);
  }
  if (new Set(Object.values(renames)).size !== Object.keys(renames).length) issues.push("renames: two fields cannot take the same new name");
  if (issues.length > 0) throw new AppError("VALIDATION_ERROR", "Field renames do not match the definition", 422, { issues });
}

/**
 * Settings that point at a field by name follow its rename (display field, a uid's source field). Runs on
 * the definition as sent, before validation — the validator would refuse a pointer to the old name.
 * Anything that is not shaped like a definition is returned untouched for the validator to report.
 */
export function followRenames(raw: unknown, renames: FieldRenames): unknown {
  if (Object.keys(renames).length === 0 || !isObject(raw) || !Array.isArray(raw.fields)) return raw;
  const displayField = typeof raw.displayField === "string" ? (renames[raw.displayField] ?? raw.displayField) : raw.displayField;
  return {
    ...raw,
    ...(displayField !== undefined ? { displayField } : {}),
    fields: raw.fields.map((f) =>
      isObject(f) && f.type === FieldType.Uid && typeof f.targetField === "string" && renames[f.targetField] ? { ...f, targetField: renames[f.targetField] } : f,
    ),
  };
}

const renameKeys = (obj: Obj, renames: FieldRenames): Obj | null => {
  if (!Object.keys(renames).some((from) => from in obj)) return null;
  // key order is kept: the new name sits where the old one was
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [renames[k] ?? k, v]));
};

/** Every value of component `uid` inside `values` gets its keys renamed. Returns null when nothing changed. */
function renameInsideComponent(def: ContentTypeDefinition, values: Obj, componentMap: ComponentMap, uid: string, renames: FieldRenames, depth = 0): Obj | null {
  if (depth > MAX_DEPTH) return null;
  let out: Obj | null = null;
  const put = (key: string, v: unknown) => {
    if (!out) out = { ...values };
    out[key] = v;
  };
  const visit = (comp: ContentTypeDefinition, compUid: string, obj: Obj): Obj | null => {
    const deeper = renameInsideComponent(comp, obj, componentMap, uid, renames, depth + 1);
    const renamed = compUid === uid ? renameKeys(deeper ?? obj, renames) : null;
    return renamed ?? deeper;
  };
  for (const field of def.fields as FieldDef[]) {
    const value = values[field.name];
    if (field.type === FieldType.Component) {
      const comp = componentMap.get(field.component);
      if (!comp) continue;
      if (Array.isArray(value)) {
        const next = value.map((item) => (isObject(item) ? (visit(comp, field.component, item) ?? item) : item));
        if (next.some((n, i) => n !== value[i])) put(field.name, next);
      } else if (isObject(value)) {
        const next = visit(comp, field.component, value);
        if (next) put(field.name, next);
      }
    } else if (field.type === FieldType.DynamicZone && Array.isArray(value)) {
      const next = value.map((b) => {
        if (!isObject(b)) return b;
        const compUid = String(b.__component);
        const comp = componentMap.get(compUid);
        return comp ? (visit(comp, compUid, b) ?? b) : b;
      });
      if (next.some((n, i) => n !== value[i])) put(field.name, next);
    }
  }
  return out;
}

/**
 * Moves stored values to the new field names — in every entry of the type, or (for a component) in every
 * entry of every type that uses the component, at any depth. Returns the ids of the entries it changed;
 * call resyncDerived for them once the new definition is saved.
 */
export async function renameInEntries(
  ctx: CommandCtx,
  change: { type: ContentTypeRow } | { componentUid: string },
  renames: FieldRenames,
): Promise<string[]> {
  if (Object.keys(renames).length === 0) return [];
  const componentMap = await loadComponentMap(ctx.db, ctx.workspaceId);
  const targets =
    "type" in change
      ? [change.type]
      : (await ctx.db.select().from(contentTypes).where(eq(contentTypes.workspaceId, ctx.workspaceId))).filter((t) =>
          usesComponent(t.definition, change.componentUid, componentMap),
        );
  const changed: string[] = [];
  for (const type of targets) {
    for (let offset = 0; ; offset += BATCH) {
      const batch = await ctx.db
        .select({ id: entries.id, values: entries.values })
        .from(entries)
        .where(and(eq(entries.workspaceId, ctx.workspaceId), eq(entries.contentTypeId, type.id)))
        .orderBy(entries.id)
        .limit(BATCH)
        .offset(offset);
      for (const e of batch) {
        const values = (e.values ?? {}) as Obj;
        const next = "type" in change ? renameKeys(values, renames) : renameInsideComponent(type.definition, values, componentMap, change.componentUid, renames);
        if (!next) continue;
        await ctx.db.update(entries).set({ values: next }).where(eq(entries.id, e.id));
        changed.push(e.id);
      }
      if (batch.length < BATCH) break;
    }
  }
  return changed;
}

/** Tables that remember a field by name (relations, asset usage) are rebuilt for these entries */
export async function resyncDerived(ctx: CommandCtx, entryIds: string[]): Promise<void> {
  if (entryIds.length === 0) return;
  const { syncEntryRelations } = await import("./relations.js");
  const { syncAssetUsages } = await import("./asset-usages.js");
  const types = new Map((await ctx.db.select().from(contentTypes).where(eq(contentTypes.workspaceId, ctx.workspaceId))).map((t) => [t.id, t]));
  for (let i = 0; i < entryIds.length; i += BATCH) {
    const rows = await ctx.db.select().from(entries).where(inArray(entries.id, entryIds.slice(i, i + BATCH)));
    for (const row of rows) {
      const type = types.get(row.contentTypeId);
      if (!type) continue;
      await syncEntryRelations(ctx, type.definition, row);
      await syncAssetUsages(ctx, type.definition, row);
    }
  }
}

// ── Added fields: when ──────────────────────────────────────────

/**
 * Stamps `addedAt` on fields that are new in this definition, and carries it over for the others (through
 * a rename too). The entry screen compares it with the entry's last save to point out fields the entry has
 * never been saved with. The stamp is the server's — whatever a client sent is replaced.
 */
export function stampAddedAt(previous: ContentTypeDefinition | null, next: ContentTypeDefinition, renames: FieldRenames = {}, now = new Date()): ContentTypeDefinition {
  const old = new Map(((previous?.fields ?? []) as FieldDef[]).map((f) => [f.name, f]));
  const cameFrom = Object.fromEntries(Object.entries(renames).map(([from, to]) => [to, from]));
  const fields = (next.fields as FieldDef[]).map((f) => {
    const { addedAt: _sent, ...rest } = f as FieldDef & { addedAt?: string };
    const source = old.get(cameFrom[f.name] ?? f.name) as (FieldDef & { addedAt?: string }) | undefined;
    // a brand-new definition has no "added later" fields
    const addedAt = !previous ? undefined : source ? source.addedAt : now.toISOString();
    return (addedAt ? { ...rest, addedAt } : rest) as FieldDef;
  });
  return { ...next, fields: fields as ContentTypeDefinition["fields"] };
}
