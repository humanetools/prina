/**
 * Public list filtering (user decision 2026-08-24) — Strapi-style `filters[field][$op]=value`
 * on GET /delivery/:type. QA runs against Strapi behavior, and headless frontend devs already
 * know this syntax; only flat AND combinations are supported (no $and/$or nesting in v1).
 *
 * Values live in the entries.values JSONB. Everything from the URL rides as bound
 * parameters — field names are whitelisted against the type definition and operators
 * against the per-family lists below, so nothing is ever interpolated raw.
 */
import { SQL, sql } from "drizzle-orm";
import { FieldType, type ContentTypeDefinition, type FieldDef } from "@prina/shared";
import { entries } from "../../db/schema/index.js";
import { ValidationError } from "../../lib/errors.js";

export interface FilterSpec {
  field: string;
  op: string;
  raw: string;
}

/** filters[title][$eq] · filters[featured] (bare = $eq) */
const KEY_RE = /^filters\[([^\]]+)\](?:\[(\$[a-zA-Z]+)\])?$/;

const STRING_OPS = ["$eq", "$ne", "$in", "$notIn", "$contains", "$notContains", "$lt", "$lte", "$gt", "$gte", "$null"];
const NUMBER_OPS = ["$eq", "$ne", "$in", "$notIn", "$lt", "$lte", "$gt", "$gte", "$null"];
const BOOLEAN_OPS = ["$eq", "$ne", "$null"];
const RELATION_OPS = ["$eq", "$ne", "$in", "$notIn", "$null"];

/** Field families that can be filtered; richtext/json/media/component/dz/variant cannot */
const STRING_TYPES = new Set([FieldType.Text, FieldType.Uid, FieldType.Enum, FieldType.Date]);

export function parseFilterParams(query: Record<string, unknown>): FilterSpec[] {
  const specs: FilterSpec[] = [];
  for (const [key, value] of Object.entries(query)) {
    const m = KEY_RE.exec(key);
    if (!m) continue;
    // A repeated key arrives as an array — each occurrence is its own AND condition
    for (const v of Array.isArray(value) ? value : [value]) {
      specs.push({ field: m[1]!, op: m[2] ?? "$eq", raw: String(v) });
    }
  }
  return specs;
}

export function buildFilterConditions(definition: ContentTypeDefinition, specs: FilterSpec[]): SQL[] {
  const byName = new Map(definition.fields.map((f) => [f.name, f]));
  return specs.map((s) => {
    const field = byName.get(s.field);
    if (!field) throw new ValidationError(`Unknown filter field '${s.field}'`);
    return condition(field, s);
  });
}

/** values ->> field (text) */
const text = (f: string) => sql`${entries.values} ->> ${f}`;
/** values -> field (jsonb node) */
const node = (f: string) => sql`${entries.values} -> ${f}`;

const esc = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const list = (raw: string) => raw.split(",").map((s) => s.trim()).filter(Boolean);
const inList = (vals: string[]) => sql.join(vals.map((v) => sql`${v}`), sql`, `);

function reject(field: FieldDef, op: string): never {
  throw new ValidationError(`Operator '${op}' is not supported on ${field.type} field '${field.name}'`);
}

function condition(field: FieldDef, s: FilterSpec): SQL {
  const { op, raw } = s;
  const f = field.name;

  if (op === "$null") {
    const isNull = sql`(${node(f)} IS NULL OR ${node(f)} = 'null'::jsonb)`;
    return raw === "false" ? sql`NOT ${isNull}` : isNull;
  }

  if (STRING_TYPES.has(field.type)) {
    if (!STRING_OPS.includes(op)) reject(field, op);
    switch (op) {
      case "$eq": return sql`${text(f)} = ${raw}`;
      // IS DISTINCT FROM: entries missing the field also count as "not equal"
      case "$ne": return sql`${text(f)} IS DISTINCT FROM ${raw}`;
      case "$in": return sql`${text(f)} IN (${inList(list(raw))})`;
      case "$notIn": return sql`${text(f)} NOT IN (${inList(list(raw))})`;
      case "$contains": return sql`${text(f)} ILIKE ${`%${esc(raw)}%`}`;
      case "$notContains": return sql`${text(f)} NOT ILIKE ${`%${esc(raw)}%`}`;
      case "$lt": return sql`${text(f)} < ${raw}`;
      case "$lte": return sql`${text(f)} <= ${raw}`;
      case "$gt": return sql`${text(f)} > ${raw}`;
      case "$gte": return sql`${text(f)} >= ${raw}`;
    }
  }

  if (field.type === FieldType.Number) {
    if (!NUMBER_OPS.includes(op)) reject(field, op);
    const nums = (op === "$in" || op === "$notIn" ? list(raw) : [raw]).map((v) => {
      const n = Number(v);
      if (!Number.isFinite(n)) throw new ValidationError(`Filter '${f}' expects a number, got '${v}'`);
      return n;
    });
    // jsonb_typeof guard: a non-number value in some entry must filter out, not blow up the cast
    const num = sql`(jsonb_typeof(${node(f)}) = 'number' AND (${node(f)})::numeric`;
    switch (op) {
      case "$eq": return sql`${num} = ${nums[0]!})`;
      case "$ne": return sql`${num} <> ${nums[0]!})`;
      case "$in": return sql`${num} IN (${inList2(nums)}))`;
      case "$notIn": return sql`${num} NOT IN (${inList2(nums)}))`;
      case "$lt": return sql`${num} < ${nums[0]!})`;
      case "$lte": return sql`${num} <= ${nums[0]!})`;
      case "$gt": return sql`${num} > ${nums[0]!})`;
      case "$gte": return sql`${num} >= ${nums[0]!})`;
    }
  }

  if (field.type === FieldType.Boolean) {
    if (!BOOLEAN_OPS.includes(op)) reject(field, op);
    if (raw !== "true" && raw !== "false") {
      throw new ValidationError(`Filter '${f}' expects true or false, got '${raw}'`);
    }
    return op === "$eq" ? sql`${text(f)} = ${raw}` : sql`${text(f)} IS DISTINCT FROM ${raw}`;
  }

  if (field.type === FieldType.Relation) {
    if (!RELATION_OPS.includes(op)) reject(field, op);
    const kind = (field as { relationKind?: string }).relationKind;
    const many = kind === "oneToMany" || kind === "manyToMany";
    if (many) {
      // Owner-side value is an id array — $eq means "contains this id"
      const contains = (id: string) => sql`${node(f)} @> ${JSON.stringify([id])}::jsonb`;
      switch (op) {
        case "$eq": return contains(raw);
        case "$ne": return sql`NOT (${node(f)} @> ${JSON.stringify([raw])}::jsonb)`;
        case "$in": return sql`(${sql.join(list(raw).map(contains), sql` OR `)})`;
        case "$notIn": return sql`NOT (${sql.join(list(raw).map(contains), sql` OR `)})`;
      }
    }
    switch (op) {
      case "$eq": return sql`${text(f)} = ${raw}`;
      case "$ne": return sql`${text(f)} IS DISTINCT FROM ${raw}`;
      case "$in": return sql`${text(f)} IN (${inList(list(raw))})`;
      case "$notIn": return sql`${text(f)} NOT IN (${inList(list(raw))})`;
    }
  }

  throw new ValidationError(`Field '${f}' (${field.type}) cannot be filtered`);
}

const inList2 = (nums: number[]) => sql.join(nums.map((n) => sql`${n}`), sql`, `);
