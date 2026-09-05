/**
 * Automatic MCP tool generation (T6.2/T6.3) — the third derivation of the schema pipeline (T1.3).
 * Content type definition → JSON Schema → tool inputSchema. Execution is only existing command calls
 * (Phase 6 premise: no new business logic).
 */
import { eq } from "drizzle-orm";
import { EntryStatus } from "@prina/shared";
import { contentTypes } from "../db/schema/index.js";
import type { Db } from "../db/client.js";
import type { CommandCtx, Services } from "../commands/context.js";
import { compileDefinitionToObjectSchema } from "../content/schema-compiler.js";
import { loadComponentMap } from "../modules/content-type/repo.js";
import {
  entryCreate,
  entryDelete,
  entryGet,
  entryList,
  entryUpdate,
} from "../modules/entry/commands.js";
import { entryTransition } from "../modules/entry/transition-commands.js";
import { entryBulkCreate } from "../modules/entry/bulk-commands.js";
import { searchPublished } from "../modules/delivery/search.js";
import { traverseGraph } from "../modules/delivery/traverse.js";
import { deliveryGet, deliveryList, type DeliveryCtx } from "../modules/delivery/service.js";
import { addStaticEntryTools } from "./entry-tools.js";
import { addSchemaTools } from "./schema-tools.js";
import { addSettingsTools } from "./settings-tools.js";

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

type Json = Record<string, unknown>;
type Handler = (args: Json) => Promise<unknown>;

export interface ToolSet {
  tools: McpToolDef[];
  handlers: Map<string, Handler>;
}

const ID = { type: "string", format: "uuid" };

/** Management plane (T6.2): per-type CRUD, transitions, bulk creation + CTB */
export async function buildManagementTools(
  db: Db,
  services: Services,
  ctx: CommandCtx,
): Promise<ToolSet> {
  const types = await db
    .select()
    .from(contentTypes)
    .where(eq(contentTypes.workspaceId, ctx.workspaceId));
  const componentMap = await loadComponentMap(db, ctx.workspaceId);

  const tools: McpToolDef[] = [];
  const handlers = new Map<string, Handler>();
  // First registration wins — the static entry tools must beat a per-type name collision
  const add = (tool: McpToolDef, handler: Handler) => {
    if (handlers.has(tool.name)) return;
    tools.push(tool);
    handlers.set(tool.name, handler);
  };
  // Content-type (schema) tools — list/create/update/delete
  addSchemaTools(add, db, services, ctx);

  // Workspace settings — SEO/GEO defaults and GA4 market config
  addSettingsTools(add, ctx);

  // Static entry tools (uid as argument) — stale-proof; registered before the per-type
  // loop so they win any name collision
  addStaticEntryTools(add, db, ctx);

  for (const type of types) {
    const valuesSchema = compileDefinitionToObjectSchema(type.definition, {
      registry: services.registry,
      resolveComponent: (uid) => componentMap.get(uid),
    });
    const uid = type.uid;

    add(
      {
        name: `${uid}_list`,
        description: `List ${type.name}`,
        inputSchema: {
          type: "object",
          properties: {
            locale: { type: "string" },
            status: { type: "string", enum: Object.values(EntryStatus) },
            page: { type: "integer", minimum: 1 },
            pageSize: { type: "integer", minimum: 1, maximum: 100 },
          },
        },
      },
      (args) => entryList.run({ ...args, typeUid: uid }, ctx),
    );
    add(
      {
        name: `${uid}_get`,
        description: `Get one ${type.name} (effective values and completeness included)`,
        inputSchema: { type: "object", properties: { id: ID }, required: ["id"] },
      },
      (args) => entryGet.run({ ...args, typeUid: uid }, ctx),
    );
    add(
      {
        name: `${uid}_create`,
        description: `Create a ${type.name} (created as draft — publish via ${uid}_transition)`,
        inputSchema: {
          type: "object",
          properties: { values: valuesSchema, locale: { type: "string" } },
          required: ["values"],
        },
      },
      (args) => entryCreate.run({ ...args, typeUid: uid }, ctx),
    );
    add(
      {
        name: `${uid}_update`,
        description: `Patch a ${type.name} (values is a patch — only sent fields change)`,
        inputSchema: {
          type: "object",
          properties: { id: ID, values: valuesSchema },
          required: ["id", "values"],
        },
      },
      (args) => entryUpdate.run({ ...args, typeUid: uid }, ctx),
    );
    add(
      {
        name: `${uid}_delete`,
        description: `Delete one ${type.name} — permanent. To unpublish instead, use ${uid}_transition back to draft`,
        inputSchema: { type: "object", properties: { id: ID }, required: ["id"] },
      },
      (args) => entryDelete.run({ ...args, typeUid: uid }, ctx),
    );
    add(
      {
        name: `${uid}_transition`,
        description: `Move a ${type.name} through the workflow — role permissions and guards apply`,
        inputSchema: {
          type: "object",
          properties: {
            id: ID,
            to: { type: "string", enum: Object.values(EntryStatus) },
          },
          required: ["id", "to"],
        },
      },
      (args) => entryTransition.run({ ...args, typeUid: uid }, ctx),
    );
    add(
      {
        name: `${uid}_bulk_create`,
        description: `Bulk create ${type.name} (up to 500, returns a per-row result)`,
        inputSchema: {
          type: "object",
          properties: {
            locale: { type: "string" },
            items: {
              type: "array",
              items: {
                type: "object",
                properties: { values: valuesSchema },
                required: ["values"],
              },
              minItems: 1,
              maxItems: 500,
            },
          },
          required: ["items"],
        },
      },
      (args) => entryBulkCreate.run({ ...args, typeUid: uid }, ctx),
    );
  }
  return { tools, handlers };
}

/** Delivery plane (T6.3): read-only, published only + cross-type search */
export async function buildDeliveryTools(
  db: Db,
  services: Services,
  workspace: DeliveryCtx["workspace"],
  localeScope: string | null,
): Promise<ToolSet> {
  const dctx: DeliveryCtx = { db, services, workspace, includeDraft: false };
  const types = await db
    .select({ uid: contentTypes.uid, name: contentTypes.name })
    .from(contentTypes)
    .where(eq(contentTypes.workspaceId, workspace.id));

  const tools: McpToolDef[] = [];
  const handlers = new Map<string, Handler>();
  const add = (tool: McpToolDef, handler: Handler) => {
    tools.push(tool);
    handlers.set(tool.name, handler);
  };
  const scopedLocale = (requested: unknown): string | undefined =>
    localeScope ?? (typeof requested === "string" ? requested : undefined);

  add(
    {
      name: "search",
      description:
        "Search across all published content — full text + trigram, fused with semantic vector search when an embedding provider is configured",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 1 },
          typeUid: { type: "string" },
          locale: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 50 },
        },
        required: ["query"],
      },
    },
    (args) =>
      searchPublished(db, workspace.id, String(args.query), {
        typeUid: typeof args.typeUid === "string" ? args.typeUid : undefined,
        locale: scopedLocale(args.locale),
        limit: typeof args.limit === "number" ? args.limit : undefined,
      }),
  );

  add(
    {
      name: "graph_traverse",
      description:
        "Traverse the knowledge graph from one published entry along relation fields (multi-hop). " +
        "Pass `path` (chain of relation field names, e.g. [\"series\",\"brand\"]) to follow a specific route, " +
        "or `depth` to expand every relation up to N hops. Returns nodes, edges and the reached targets.",
      inputSchema: {
        type: "object",
        properties: {
          id: ID,
          path: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            maxItems: 5,
            description: "Relation field names to follow, one per hop",
          },
          depth: { type: "integer", minimum: 1, maximum: 5 },
        },
        required: ["id"],
      },
    },
    (args) =>
      traverseGraph(db, workspace.id, {
        startId: String(args.id),
        path: Array.isArray(args.path) ? (args.path as string[]) : undefined,
        depth: typeof args.depth === "number" ? args.depth : undefined,
        publishedOnly: true,
      }),
  );

  for (const type of types) {
    add(
      {
        name: `${type.uid}_list`,
        description: `List published ${type.name} (paged — check total and page through)`,
        inputSchema: {
          type: "object",
          properties: {
            locale: { type: "string" },
            page: { type: "number" },
            pageSize: { type: "number", description: "max 100" },
          },
        },
      },
      (args) =>
        deliveryList(dctx, type.uid, scopedLocale(args.locale), {
          page: Number(args.page) || 1,
          pageSize: Number(args.pageSize) || 100,
        }),
    );
    add(
      {
        name: `${type.uid}_get`,
        description: `Get one published ${type.name} (effective values)`,
        inputSchema: { type: "object", properties: { id: ID }, required: ["id"] },
      },
      async (args) => {
        const r = await deliveryGet(dctx, type.uid, String(args.id));
        return {
          id: r.entry.id,
          locale: r.entry.locale,
          publishedAt: r.entry.publishedAt,
          values: r.values,
        };
      },
    );
  }
  return { tools, handlers };
}
