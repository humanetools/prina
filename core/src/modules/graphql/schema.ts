/**
 * GraphQL read schema (18-IMPL A) — generated from the workspace's content types. Read-only,
 * published-by-default (a delivery draft token widens it), same filter operators and
 * whitelist as the REST delivery plane so the two surfaces never disagree.
 *
 *   type Product { id documentId locale status publishedAt updatedAt  <fields…> }
 *   input ProductWhere { name: StringFilter, price: NumberFilter, brand: IdFilter, … }   (flat AND)
 *   enum ProductOrderField { publishedAt updatedAt name price … }
 *   type ProductPage { items: [Product!]! total: Int! }
 *   Query { products(where, orderBy, limit, offset, locale): ProductPage!  product(id: ID!): Product
 *           brandName(locale): BrandName }                                  ← single type
 *
 * Field mapping: text/uid/date → String · richtext → RichText{doc,text} · number → Float ·
 * boolean → Boolean · enum → String (values are free text, often non-ASCII) · json → JSON ·
 * media → Media/[Media] · relation → target type (list for *-to-many) · component → object ·
 * dynamic_zone → union of its components (resolved by the stored __component; exposed as
 * `component`) · variant_axis → String.
 * Names that are not valid GraphQL identifiers are sanitized; collisions with the meta fields
 * are prefixed with `field_`.
 */
import {
  GraphQLBoolean,
  GraphQLEnumType,
  GraphQLFloat,
  GraphQLID,
  GraphQLInputObjectType,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLScalarType,
  GraphQLSchema,
  GraphQLString,
  GraphQLUnionType,
  Kind,
  type GraphQLFieldConfigMap,
  type GraphQLInputFieldConfigMap,
  type GraphQLOutputType,
  type ValueNode,
} from "graphql";
import { FieldType, type ContentTypeDefinition, type FieldDef } from "@prina/shared";
import type { FilterSpec } from "../delivery/filters.js";
import type { GqlContext } from "./execute.js";

export interface GqlTypeRow {
  id: string;
  uid: string;
  name: string;
  kind: string;
  definition: ContentTypeDefinition;
}

// ── naming ──────────────────────────────────────────────────────────────────
const IDENT = /^[_A-Za-z][_0-9A-Za-z]*$/;
export function pascal(uid: string): string {
  const p = uid
    .split(/[^0-9A-Za-z]+/)
    .filter(Boolean)
    .map((s) => s[0]!.toUpperCase() + s.slice(1))
    .join("");
  return /^[0-9]/.test(p) ? `T${p}` : p || "Type";
}
export function camel(uid: string): string {
  const p = pascal(uid);
  return p[0]!.toLowerCase() + p.slice(1);
}
/** Naive English plural for the list field — collisions fall back to `<camel>List` */
export function plural(word: string): string {
  if (/[^aeiou]y$/i.test(word)) return word.slice(0, -1) + "ies";
  if (/(s|x|z|ch|sh)$/i.test(word)) return word + "es";
  return word + "s";
}
const META = new Set(["id", "documentId", "locale", "status", "publishedAt", "updatedAt", "url"]);
function gqlFieldName(name: string): string {
  let n = name.replace(/[^_0-9A-Za-z]/g, "_");
  if (!IDENT.test(n)) n = `f_${n}`;
  if (META.has(n)) n = `field_${n}`;
  return n;
}

// ── scalars & shared types ──────────────────────────────────────────────────
const parseLiteral = (ast: ValueNode): unknown => {
  switch (ast.kind) {
    case Kind.STRING: case Kind.BOOLEAN: return ast.value;
    case Kind.INT: case Kind.FLOAT: return Number(ast.value);
    case Kind.NULL: return null;
    case Kind.LIST: return ast.values.map(parseLiteral);
    case Kind.OBJECT: return Object.fromEntries(ast.fields.map((f) => [f.name.value, parseLiteral(f.value)]));
    default: return null;
  }
};
export const JSONScalar = new GraphQLScalarType({
  name: "JSON",
  description: "Arbitrary JSON value",
  serialize: (v) => v,
  parseValue: (v) => v,
  parseLiteral,
});
const MediaType = new GraphQLObjectType({
  name: "Media",
  description: "An asset from the media library (populated)",
  fields: {
    id: { type: new GraphQLNonNull(GraphQLID) },
    url: { type: GraphQLString },
    filename: { type: GraphQLString },
    mime: { type: GraphQLString },
    width: { type: GraphQLInt },
    height: { type: GraphQLInt },
    alt: { type: GraphQLString, description: "a11y text; empty string = decorative" },
  },
});
const RichTextType = new GraphQLObjectType({
  name: "RichText",
  fields: {
    doc: { type: JSONScalar, description: "ProseMirror document" },
    text: { type: GraphQLString, description: "Plain text extracted from the document", resolve: (doc: unknown) => pmText(doc) },
  },
});
function pmText(doc: unknown): string {
  const out: string[] = [];
  const walk = (n: unknown): void => {
    if (!n || typeof n !== "object") return;
    const node = n as { type?: string; text?: string; content?: unknown[] };
    if (typeof node.text === "string") out.push(node.text);
    if (Array.isArray(node.content)) {
      node.content.forEach(walk);
      if (node.type === "paragraph" || node.type === "heading") out.push("\n");
    }
  };
  walk(doc);
  return out.join("").trim();
}

const filterInput = (name: string, ops: Array<[string, GraphQLOutputType | GraphQLScalarType]>) =>
  new GraphQLInputObjectType({
    name,
    fields: Object.fromEntries(ops.map(([op, t]) => [op, { type: t as never }])) as GraphQLInputFieldConfigMap,
  });
const StringFilter = filterInput("StringFilter", [
  ["eq", GraphQLString], ["ne", GraphQLString], ["in", new GraphQLList(new GraphQLNonNull(GraphQLString))],
  ["notIn", new GraphQLList(new GraphQLNonNull(GraphQLString))], ["contains", GraphQLString], ["notContains", GraphQLString],
  ["lt", GraphQLString], ["lte", GraphQLString], ["gt", GraphQLString], ["gte", GraphQLString], ["null", GraphQLBoolean],
]);
const NumberFilter = filterInput("NumberFilter", [
  ["eq", GraphQLFloat], ["ne", GraphQLFloat], ["in", new GraphQLList(new GraphQLNonNull(GraphQLFloat))],
  ["notIn", new GraphQLList(new GraphQLNonNull(GraphQLFloat))], ["lt", GraphQLFloat], ["lte", GraphQLFloat],
  ["gt", GraphQLFloat], ["gte", GraphQLFloat], ["null", GraphQLBoolean],
]);
const BooleanFilter = filterInput("BooleanFilter", [["eq", GraphQLBoolean], ["ne", GraphQLBoolean], ["null", GraphQLBoolean]]);
const IdFilter = filterInput("IdFilter", [
  ["eq", GraphQLID], ["ne", GraphQLID], ["in", new GraphQLList(new GraphQLNonNull(GraphQLID))],
  ["notIn", new GraphQLList(new GraphQLNonNull(GraphQLID))], ["null", GraphQLBoolean],
]);
const OrderDir = new GraphQLEnumType({ name: "OrderDir", values: { ASC: { value: "asc" }, DESC: { value: "desc" } } });

/** Which filter input a field takes — null = not filterable (same families as filters.ts) */
function filterFor(f: FieldDef) {
  switch (f.type) {
    case FieldType.Text: case FieldType.Uid: case FieldType.Enum: case FieldType.Date: return StringFilter;
    case FieldType.Number: return NumberFilter;
    case FieldType.Boolean: return BooleanFilter;
    case FieldType.Relation: return IdFilter;
    default: return null;
  }
}

/** GraphQL `where` object → the REST plane's FilterSpec list (flat AND) */
export function whereToSpecs(where: Record<string, Record<string, unknown>> | null | undefined, gqlToField: Map<string, string>): FilterSpec[] {
  const specs: FilterSpec[] = [];
  if (!where) return specs;
  for (const [gqlName, ops] of Object.entries(where)) {
    const field = gqlToField.get(gqlName) ?? gqlName;
    if (!ops) continue;
    for (const [op, v] of Object.entries(ops)) {
      if (v === undefined || v === null) continue;
      const raw = Array.isArray(v) ? v.map(String).join(",") : String(v);
      specs.push({ field, op: `$${op}`, raw });
    }
  }
  return specs;
}

export interface SortSpec {
  field: string;
  dir: "asc" | "desc";
  numeric: boolean;
}

// ── schema build ────────────────────────────────────────────────────────────
export function buildSchema(types: GqlTypeRow[], components: Map<string, ContentTypeDefinition>): GraphQLSchema {
  const typeByUid = new Map(types.map((t) => [t.uid, t]));
  const objectTypes = new Map<string, GraphQLObjectType>();
  const componentTypes = new Map<string, GraphQLObjectType>();
  const usedNames = new Set<string>(["Media", "RichText", "JSON", "Query", "OrderDir", "StringFilter", "NumberFilter", "BooleanFilter", "IdFilter"]);
  const unique = (base: string) => {
    let n = base;
    let i = 2;
    while (usedNames.has(n)) n = `${base}${i++}`;
    usedNames.add(n);
    return n;
  };

  const componentType = (uid: string): GraphQLObjectType | null => {
    const cached = componentTypes.get(uid);
    if (cached) return cached;
    const def = components.get(uid);
    if (!def) return null;
    const t = new GraphQLObjectType({
      name: unique(`Component${pascal(uid)}`),
      fields: () => ({
        // "__component" is the stored discriminator; GraphQL reserves the "__" prefix
        component: { type: GraphQLString, description: "Component uid", resolve: () => uid },
        ...valueFields(def),
      }),
    });
    componentTypes.set(uid, t);
    return t;
  };

  /** Output type for one field; null = skip (unmappable) */
  const outputFor = (f: FieldDef): { type: GraphQLOutputType; resolve?: (src: Record<string, unknown>, args: unknown, ctx: GqlContext) => unknown } | null => {
    switch (f.type) {
      case FieldType.Text: case FieldType.Uid: case FieldType.Date: case FieldType.Enum: case FieldType.VariantAxis:
        return { type: GraphQLString, resolve: (src) => (src[f.name] == null ? null : String(src[f.name])) };
      case FieldType.Richtext:
        return { type: RichTextType, resolve: (src) => src[f.name] ?? null };
      case FieldType.Number:
        return { type: GraphQLFloat, resolve: (src) => (typeof src[f.name] === "number" ? src[f.name] : src[f.name] == null ? null : Number(src[f.name])) };
      case FieldType.Boolean:
        return { type: GraphQLBoolean };
      case FieldType.Json:
        return { type: JSONScalar };
      case FieldType.Media: {
        const multiple = (f as { multiple?: boolean }).multiple === true;
        // populated by populateValuesList: {id,url,filename,mime,width,height,alt} or a list of them
        return { type: multiple ? new GraphQLList(MediaType) : MediaType, resolve: (src) => {
          const v = src[f.name];
          if (v == null) return multiple ? [] : null;
          if (multiple) return Array.isArray(v) ? v.filter((x) => x && typeof x === "object") : [v].filter((x) => x && typeof x === "object");
          const one = Array.isArray(v) ? v[0] : v;
          return one && typeof one === "object" ? one : null;
        } };
      }
      case FieldType.Relation: {
        const rf = f as { target: string; relationKind: string };
        const targetRow = typeByUid.get(rf.target);
        const many = rf.relationKind === "oneToMany" || rf.relationKind === "manyToMany";
        if (!targetRow) return { type: many ? new GraphQLList(JSONScalar) : JSONScalar };
        const target = () => objectTypes.get(rf.target)!;
        return {
          type: many ? new GraphQLList(lazy(target)) : lazy(target),
          // populate turned ids into {id,…} summaries — load the full published target entries
          resolve: async (src, _a, ctx) => {
            const v = src[f.name];
            const ids = (Array.isArray(v) ? v : v == null ? [] : [v])
              .map((x) => (x && typeof x === "object" ? (x as { id?: string }).id : (x as string)))
              .filter((x): x is string => typeof x === "string");
            const rows = await ctx.loadEntries(rf.target, ids);
            return many ? rows : (rows[0] ?? null);
          },
        };
      }
      case FieldType.Component: {
        const cf = f as { component: string; repeatable?: boolean };
        const ct = componentType(cf.component);
        if (!ct) return { type: JSONScalar };
        return { type: cf.repeatable ? new GraphQLList(ct) : ct };
      }
      case FieldType.DynamicZone: {
        const dz = f as { components: string[] };
        const members = dz.components.map(componentType).filter((x): x is GraphQLObjectType => !!x);
        if (members.length === 0) return { type: new GraphQLList(JSONScalar) };
        const union = new GraphQLUnionType({
          name: unique(`DynamicZone${pascal(f.name)}`),
          types: members,
          resolveType: (value: { __component?: string }) => componentTypes.get(String(value.__component))?.name,
        });
        return { type: new GraphQLList(union) };
      }
      default:
        return null;
    }
  };

  const valueFields = (def: ContentTypeDefinition): GraphQLFieldConfigMap<Record<string, unknown>, GqlContext> => {
    const out: GraphQLFieldConfigMap<Record<string, unknown>, GqlContext> = {};
    for (const f of def.fields ?? []) {
      const o = outputFor(f);
      if (!o) continue;
      const name = gqlFieldName(f.name);
      if (out[name]) continue;
      out[name] = {
        type: o.type,
        description: f.label ? String(f.label) : undefined,
        resolve: o.resolve ?? ((src) => src[f.name] ?? null),
      };
    }
    return out;
  };

  // Entry object types (lazy fields so relations can point at each other)
  for (const t of types) {
    objectTypes.set(
      t.uid,
      new GraphQLObjectType({
        name: unique(pascal(t.uid)),
        description: t.name,
        fields: () => ({
          id: { type: new GraphQLNonNull(GraphQLID), resolve: (src) => src.__meta.id },
          documentId: { type: GraphQLID, resolve: (src) => src.__meta.documentId },
          locale: { type: GraphQLString, resolve: (src) => src.__meta.locale },
          status: { type: GraphQLString, resolve: (src) => src.__meta.status },
          publishedAt: { type: GraphQLString, resolve: (src) => iso(src.__meta.publishedAt) },
          updatedAt: { type: GraphQLString, resolve: (src) => iso(src.__meta.updatedAt) },
          ...valueFields(t.definition),
        }),
      }),
    );
  }

  const queryFields: GraphQLFieldConfigMap<unknown, GqlContext> = {};
  const taken = new Set<string>();
  const claim = (base: string, fallback: string) => {
    const n = taken.has(base) ? fallback : base;
    taken.add(n);
    return n;
  };
  for (const t of types) {
    const obj = objectTypes.get(t.uid)!;
    const gqlToField = new Map<string, string>();
    const whereFields: GraphQLInputFieldConfigMap = {};
    const orderValues: Record<string, { value: string }> = { publishedAt: { value: "publishedAt" }, updatedAt: { value: "updatedAt" } };
    const numericFields = new Set<string>();
    for (const f of t.definition.fields ?? []) {
      const fi = filterFor(f);
      if (!fi) continue;
      const g = gqlFieldName(f.name);
      gqlToField.set(g, f.name);
      whereFields[g] = { type: fi };
      if (f.type !== FieldType.Relation) orderValues[g] = { value: f.name };
      if (f.type === FieldType.Number) numericFields.add(f.name);
    }
    const Where = new GraphQLInputObjectType({ name: unique(`${obj.name}Where`), fields: whereFields });
    const OrderField = new GraphQLEnumType({ name: unique(`${obj.name}OrderField`), values: orderValues });
    const OrderBy = new GraphQLInputObjectType({
      name: unique(`${obj.name}OrderBy`),
      fields: { field: { type: new GraphQLNonNull(OrderField) }, dir: { type: OrderDir, defaultValue: "desc" } },
    });
    const Page = new GraphQLObjectType({
      name: unique(`${obj.name}Page`),
      fields: { items: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(obj))) }, total: { type: new GraphQLNonNull(GraphQLInt) } },
    });
    const c = camel(t.uid);
    if (t.kind === "single") {
      queryFields[claim(c, `${c}Single`)] = {
        type: obj,
        description: `${t.name} — the single entry`,
        args: { locale: { type: GraphQLString } },
        resolve: async (_s, args: { locale?: string }, ctx) => {
          const page = await ctx.list(t.uid, { locale: args.locale, limit: 1, offset: 0, specs: [], sort: [] });
          return page.items[0] ?? null;
        },
      };
      continue;
    }
    queryFields[claim(plural(c), `${c}List`)] = {
      type: new GraphQLNonNull(Page),
      description: `${t.name} — list (published; flat AND filters)`,
      args: {
        where: { type: Where },
        orderBy: { type: new GraphQLList(new GraphQLNonNull(OrderBy)) },
        limit: { type: GraphQLInt, defaultValue: 20, description: "max 100" },
        offset: { type: GraphQLInt, defaultValue: 0 },
        locale: { type: GraphQLString },
      },
      resolve: (_s, args: { where?: Record<string, Record<string, unknown>>; orderBy?: Array<{ field: string; dir?: "asc" | "desc" }>; limit?: number; offset?: number; locale?: string }, ctx) =>
        ctx.list(t.uid, {
          locale: args.locale,
          limit: Math.min(100, Math.max(1, args.limit ?? 20)),
          offset: Math.max(0, args.offset ?? 0),
          specs: whereToSpecs(args.where, gqlToField),
          sort: (args.orderBy ?? []).map((o) => ({ field: o.field, dir: o.dir ?? "desc", numeric: numericFields.has(o.field) })),
        }),
    };
    queryFields[claim(c, `${c}ById`)] = {
      type: obj,
      description: `${t.name} — one entry by id`,
      args: { id: { type: new GraphQLNonNull(GraphQLID) } },
      resolve: (_s, args: { id: string }, ctx) => ctx.get(t.uid, args.id),
    };
  }
  if (Object.keys(queryFields).length === 0) {
    queryFields._empty = { type: GraphQLBoolean, description: "No content types yet", resolve: () => true };
  }
  return new GraphQLSchema({ query: new GraphQLObjectType({ name: "Query", fields: queryFields }) });
}

/** Wrap a lazily-resolved object type (types referencing each other) */
function lazy(get: () => GraphQLObjectType): GraphQLOutputType {
  // GraphQL.js resolves field types when the schema is built (fields are thunks), so calling
  // the getter at build time is safe — all object types are registered before Query is built.
  return get();
}
const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
