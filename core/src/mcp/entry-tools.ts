/**
 * Static entry tools (management plane) — uid comes in as an argument, so the set
 * exists regardless of which content types exist and never goes stale.
 *
 * Why alongside the generated per-type tools: clients cache tools/list and some ignore
 * listChanged, so a type created mid-session has no usable per-type tools until the
 * client reconnects. These six make "create a schema, then immediately fill it" work
 * in a single conversation. They also keep the tool list from exploding when a
 * workspace has dozens of types. Registered before the per-type loop — on a name
 * collision the static tool wins.
 *
 * Values are validated server-side against the type's definition by the command
 * pipeline (T1.3), so the loose inputSchema here loses no safety.
 */
import { eq } from "drizzle-orm";
import { EntryStatus } from "@prina/shared";
import { contentTypes } from "../db/schema/index.js";
import type { Db } from "../db/client.js";
import type { CommandCtx } from "../commands/context.js";
import { ValidationError } from "../lib/errors.js";
import { findContentTypeByUid } from "../modules/content-type/repo.js";
import {
  entryCreate,
  entryDelete,
  entryGet,
  entryList,
  entryUpdate,
} from "../modules/entry/commands.js";
import { entryTransition } from "../modules/entry/transition-commands.js";
import { entryBulkCreate } from "../modules/entry/bulk-commands.js";
import { entryAiTranslate } from "../modules/ai/translate-commands.js";
import { entrySetSeo } from "../modules/entry/seo.js";
import type { McpToolDef } from "./tools.js";

type Json = Record<string, unknown>;
type Handler = (args: Json) => Promise<unknown>;

const ID = { type: "string", format: "uuid" };
const UID = {
  type: "string",
  description: "Content type uid (see content_type_list) — works for types created in this session too",
};
const VALUES = {
  type: "object",
  description:
    "Field values keyed by field name — validated server-side against the type's definition; errors name the offending fields",
};

export function addStaticEntryTools(
  add: (tool: McpToolDef, handler: Handler) => void,
  db: Db,
  ctx: CommandCtx,
): void {
  /** Resolve uid at call time (not session start) — this is what makes the set stale-proof */
  const withType = (fn: (uid: string, args: Json) => Promise<unknown>): Handler => {
    return async (args) => {
      const uid = String(args.uid ?? "");
      const found = uid ? await findContentTypeByUid(db, ctx.workspaceId, uid) : null;
      if (!found) {
        const rows = await db
          .select({ uid: contentTypes.uid })
          .from(contentTypes)
          .where(eq(contentTypes.workspaceId, ctx.workspaceId));
        throw new ValidationError(`Content type '${uid}' not found`, {
          availableTypes: rows.map((r) => r.uid),
        });
      }
      const { uid: _omit, ...rest } = args;
      return fn(uid, rest);
    };
  };

  add(
    {
      name: "entry_list",
      description: "List entries of any content type (uid argument)",
      inputSchema: {
        type: "object",
        properties: {
          uid: UID,
          locale: { type: "string" },
          status: { type: "string", enum: Object.values(EntryStatus) },
          page: { type: "integer", minimum: 1 },
          pageSize: { type: "integer", minimum: 1, maximum: 100 },
        },
        required: ["uid"],
      },
    },
    withType((uid, args) => entryList.run({ ...args, typeUid: uid }, ctx)),
  );
  add(
    {
      name: "entry_get",
      description: "Get one entry of any content type (effective values and completeness included)",
      inputSchema: {
        type: "object",
        properties: { uid: UID, id: ID },
        required: ["uid", "id"],
      },
    },
    withType((uid, args) => entryGet.run({ ...args, typeUid: uid }, ctx)),
  );
  add(
    {
      name: "entry_create",
      description:
        "Create an entry of any content type (created as draft — publish via entry_transition)",
      inputSchema: {
        type: "object",
        properties: { uid: UID, values: VALUES, locale: { type: "string" } },
        required: ["uid", "values"],
      },
    },
    withType((uid, args) => entryCreate.run({ ...args, typeUid: uid }, ctx)),
  );
  add(
    {
      name: "entry_update",
      description: "Patch an entry of any content type (values is a patch — only sent fields change)",
      inputSchema: {
        type: "object",
        properties: { uid: UID, id: ID, values: VALUES },
        required: ["uid", "id", "values"],
      },
    },
    withType((uid, args) => entryUpdate.run({ ...args, typeUid: uid }, ctx)),
  );
  add(
    {
      name: "entry_delete",
      description:
        "Delete one entry of any content type — permanent, with no undo. Deleting is not how " +
        "you unpublish: entry_transition back to draft keeps the content.",
      inputSchema: {
        type: "object",
        properties: { uid: UID, id: ID },
        required: ["uid", "id"],
      },
    },
    withType((uid, args) => entryDelete.run({ ...args, typeUid: uid }, ctx)),
  );
  add(
    {
      name: "entry_translate",
      description:
        "AI-translate an entry into one missing locale (BYOK LLM required). Creates a DRAFT sibling for human review — publishing stays a human action. Call once per target locale; existing locales are never overwritten.",
      inputSchema: {
        type: "object",
        properties: {
          uid: UID,
          sourceEntryId: ID,
          targetLocale: { type: "string" },
        },
        required: ["uid", "sourceEntryId", "targetLocale"],
      },
    },
    withType((uid, args) => entryAiTranslate.run({ ...args, typeUid: uid }, ctx)),
  );
  add(
    {
      name: "entry_transition",
      description:
        "Move an entry of any content type through the workflow — role permissions and guards apply",
      inputSchema: {
        type: "object",
        properties: {
          uid: UID,
          id: ID,
          to: { type: "string", enum: Object.values(EntryStatus) },
        },
        required: ["uid", "id", "to"],
      },
    },
    withType((uid, args) => entryTransition.run({ ...args, typeUid: uid }, ctx)),
  );
  add(
    {
      name: "entry_bulk_create",
      description: "Bulk create entries of any content type (up to 500, returns a per-row result)",
      inputSchema: {
        type: "object",
        properties: {
          uid: UID,
          locale: { type: "string" },
          items: {
            type: "array",
            items: {
              type: "object",
              properties: { values: VALUES },
              required: ["values"],
            },
            minItems: 1,
            maxItems: 500,
          },
        },
        required: ["uid", "items"],
      },
    },
    withType((uid, args) => entryBulkCreate.run({ ...args, typeUid: uid }, ctx)),
  );
  // The SEO record is entry metadata, not a field — it lives beside `values`, which is why
  // entry_create/update cannot carry it. Readable in entry_get all along; writable here since
  // MCP QA found the write side missing (2026-08-24).
  add(
    {
      name: "entry_set_seo",
      description:
        "Set an entry's SEO record — meta title/description, canonical, Open Graph, noindex. " +
        "Full replacement, not a patch: send every key you want kept, or null to clear the record. " +
        "The type needs options.seo.enabled (content_type_update) for this to reach delivery, where " +
        "it surfaces via ?format=head and feeds sitemap.xml.",
      inputSchema: {
        type: "object",
        properties: {
          uid: UID,
          id: ID,
          seo: {
            type: ["object", "null"],
            additionalProperties: false,
            properties: {
              metaTitle: { type: "string", maxLength: 200 },
              metaDescription: { type: "string", maxLength: 500 },
              canonical: {
                type: "string",
                description: "Absolute http(s) URL — overrides the type's urlPattern resolution",
              },
              ogImage: { type: "string", format: "uuid", description: "DAM asset id for og:image" },
              ogTitle: { type: "string", maxLength: 200 },
              ogDescription: { type: "string", maxLength: 500 },
              noindex: { type: "boolean" },
            },
          },
        },
        required: ["uid", "id", "seo"],
      },
    },
    withType((uid, args) => entrySetSeo.run({ ...args, typeUid: uid }, ctx)),
  );
}
