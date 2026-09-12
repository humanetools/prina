/**
 * GraphQL read execution (18-IMPL A) — per-workspace schema cache + execution against the
 * delivery plane. No HTTP framework plugin: one schema per WORKSPACE (types differ), built on
 * demand from the content types and invalidated by the 'content-types-changed' event.
 *
 * Guards: query depth ≤ 6, list limit ≤ 100 (enforced in the resolver), introspection allowed
 * (tools and models read the schema), published-only unless the delivery draft token is valid.
 */
import {
  GraphQLError,
  Kind,
  execute,
  parse,
  printSchema,
  specifiedRules,
  validate,
  type ASTVisitor,
  type DocumentNode,
  type GraphQLSchema,
  type ValidationContext,
} from "graphql";
import { and, eq, inArray } from "drizzle-orm";
import type { EventEmitter } from "node:events";
import { EntryStatus, type ContentTypeDefinition } from "@prina/shared";
import { contentTypes, entries } from "../../db/schema/index.js";
import { loadComponentMap } from "../content-type/repo.js";
import { deliveryGet, deliveryList, type DeliveryCtx } from "../delivery/service.js";
import { populateValuesList } from "../delivery/populate.js";
import type { FilterSpec } from "../delivery/filters.js";
import { buildSchema, type GqlTypeRow, type SortSpec } from "./schema.js";

export const MAX_DEPTH = 6;

/** Resolver-facing context — data access goes through the delivery plane, never raw tables */
export interface GqlContext {
  delivery: DeliveryCtx;
  list(typeUid: string, args: { locale?: string; limit: number; offset: number; specs: FilterSpec[]; sort: SortSpec[] }): Promise<{ items: Record<string, unknown>[]; total: number }>;
  get(typeUid: string, id: string): Promise<Record<string, unknown> | null>;
  /** Relation targets — published entries of `typeUid` by id, in request order */
  loadEntries(typeUid: string, ids: string[]): Promise<Record<string, unknown>[]>;
}

interface CacheEntry {
  key: string;
  schema: GraphQLSchema;
}
const cache = new Map<string, CacheEntry>();
let wired = false;
/** Drop a workspace's schema when its types change (hook once per process) */
export function wireSchemaInvalidation(events: EventEmitter): void {
  if (wired) return;
  wired = true;
  events.on("content-types-changed", (workspaceId: string) => cache.delete(workspaceId));
}
export function resetGraphqlSchemaCache(): void {
  cache.clear();
}

export async function getWorkspaceSchema(ctx: DeliveryCtx): Promise<GraphQLSchema> {
  const rows = (await ctx.db
    .select({ id: contentTypes.id, uid: contentTypes.uid, name: contentTypes.name, kind: contentTypes.kind, definition: contentTypes.definition, version: contentTypes.version })
    .from(contentTypes)
    .where(eq(contentTypes.workspaceId, ctx.workspace.id))) as Array<GqlTypeRow & { version: number }>;
  const key = rows.map((r) => `${r.uid}@${r.version}`).sort().join("|");
  const hit = cache.get(ctx.workspace.id);
  if (hit && hit.key === key) return hit.schema;
  const components = await loadComponentMap(ctx.db, ctx.workspace.id);
  const schema = buildSchema(rows, components);
  cache.set(ctx.workspace.id, { key, schema });
  return schema;
}

export async function schemaSdl(ctx: DeliveryCtx): Promise<string> {
  return printSchema(await getWorkspaceSchema(ctx));
}

/** Entry row → resolver source: populated values + __meta (id, documentId, locale, status, dates) */
function toSource(
  meta: { id: string; documentId: string; locale: string | null; status: string; publishedAt: unknown; updatedAt?: unknown },
  values: Record<string, unknown>,
): Record<string, unknown> {
  return { ...values, __meta: meta };
}

/** Data access shared with the Flow page hydrator (18-IMPL B) — same rules as the resolvers */
export function createGqlContext(delivery: DeliveryCtx): GqlContext {
  const defs = new Map<string, ContentTypeDefinition>();
  const defOf = async (uid: string): Promise<ContentTypeDefinition> => {
    const c = defs.get(uid);
    if (c) return c;
    const [row] = await delivery.db
      .select({ definition: contentTypes.definition })
      .from(contentTypes)
      .where(and(eq(contentTypes.workspaceId, delivery.workspace.id), eq(contentTypes.uid, uid)))
      .limit(1);
    const d = (row?.definition ?? { fields: [] }) as ContentTypeDefinition;
    defs.set(uid, d);
    return d;
  };
  const populate = async (uid: string, list: Record<string, unknown>[]) =>
    list.length === 0 ? [] : populateValuesList(delivery, await defOf(uid), list);

  return {
    delivery,
    async list(typeUid, args) {
      const pageSize = args.limit;
      // deliveryList pages 1-based; offset is expressed as page + pageSize when it aligns, else
      // fetched with a wider window and sliced (offsets are small for storefront pages)
      const page = Math.floor(args.offset / pageSize) + 1;
      const aligned = args.offset % pageSize === 0;
      const res = await deliveryList(delivery, typeUid, args.locale, { page: aligned ? page : 1, pageSize: aligned ? pageSize : Math.min(100, args.offset + pageSize) }, args.specs, args.sort);
      const items = aligned ? res.items : res.items.slice(args.offset, args.offset + pageSize);
      const values = await populate(typeUid, items.map((i) => i.values as Record<string, unknown>));
      return {
        items: items.map((it, i) => toSource({ id: it.id, documentId: it.documentId, locale: it.locale, status: it.status, publishedAt: it.publishedAt, updatedAt: (it as { updatedAt?: unknown }).updatedAt }, values[i]!)),
        total: res.total,
      };
    },
    async get(typeUid, id) {
      try {
        const r = await deliveryGet(delivery, typeUid, id);
        const [values] = await populate(typeUid, [r.values]);
        return toSource({ id: r.entry.id, documentId: r.entry.documentId, locale: r.entry.locale, status: r.entry.status, publishedAt: r.entry.publishedAt, updatedAt: r.entry.updatedAt }, values!);
      } catch {
        return null;
      }
    },
    async loadEntries(typeUid, ids) {
      if (ids.length === 0) return [];
      const rows = await delivery.db
        .select({ id: entries.id, documentId: entries.documentId, locale: entries.locale, status: entries.status, publishedAt: entries.publishedAt, updatedAt: entries.updatedAt, values: entries.values })
        .from(entries)
        .innerJoin(contentTypes, eq(entries.contentTypeId, contentTypes.id))
        .where(and(
          eq(contentTypes.workspaceId, delivery.workspace.id),
          eq(contentTypes.uid, typeUid),
          inArray(entries.id, ids),
          ...(delivery.includeDraft ? [] : [eq(entries.status, EntryStatus.Published)]),
        ));
      const byId = new Map(rows.map((r) => [r.id, r]));
      const ordered = ids.map((id) => byId.get(id)).filter((r): r is NonNullable<typeof r> => !!r);
      const values = await populate(typeUid, ordered.map((r) => r.values as Record<string, unknown>));
      return ordered.map((r, i) => toSource(r, values[i]!));
    },
  };
}

/** Depth guard — nested selections beyond MAX_DEPTH are rejected before execution */
function depthLimitRule(max: number) {
  return (context: ValidationContext): ASTVisitor => {
    let depth = 0;
    return {
      Field: {
        enter(node) {
          if (node.name.value.startsWith("__")) return;
          depth++;
          if (depth > max) {
            context.reportError(new GraphQLError(`Query is nested too deeply (max ${max})`, { nodes: [node] }));
          }
        },
        leave(node) {
          if (!node.name.value.startsWith("__")) depth--;
        },
      },
      FragmentDefinition: { enter() { depth = 0; } },
    };
  };
}

export interface GqlRequest {
  query: string;
  variables?: Record<string, unknown> | null;
  operationName?: string | null;
}

export async function executeGraphql(delivery: DeliveryCtx, req: GqlRequest): Promise<{ data?: unknown; errors?: Array<{ message: string; path?: readonly (string | number)[] }> }> {
  const schema = await getWorkspaceSchema(delivery);
  let document: DocumentNode;
  try {
    document = parse(req.query);
  } catch (e) {
    return { errors: [{ message: e instanceof Error ? e.message : "Syntax error" }] };
  }
  // Read-only plane: mutations/subscriptions are not part of the schema, but say so plainly
  const op = document.definitions.find((d) => d.kind === Kind.OPERATION_DEFINITION);
  if (op && op.kind === Kind.OPERATION_DEFINITION && op.operation !== "query") {
    return { errors: [{ message: "Only queries are supported on the delivery plane (read-only)" }] };
  }
  const errors = validate(schema, document, [...specifiedRules, depthLimitRule(MAX_DEPTH)]);
  if (errors.length) return { errors: errors.map((e) => ({ message: e.message })) };
  const result = await execute({
    schema,
    document,
    variableValues: req.variables ?? undefined,
    operationName: req.operationName ?? undefined,
    contextValue: createGqlContext(delivery),
  });
  return {
    ...(result.data !== undefined ? { data: result.data } : {}),
    ...(result.errors?.length ? { errors: result.errors.map((e) => ({ message: e.message, path: e.path })) } : {}),
  };
}
