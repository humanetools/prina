/**
 * Assistant tool registry (06-IMPL-ai-assistant) — thin adapters over existing commands.
 * Each execution goes through the command pipeline (`.run`), so the session user's RBAC
 * and audit apply per action; the assistant adds no privileges of its own.
 * Irreversible actions (publish/transition) are PROPOSAL-ONLY: never executed here —
 * surfaced as cards the human clicks ("AI up to draft, humans publish").
 */
import { eq } from "drizzle-orm";
import type { EntryAiDraft } from "@prina/shared";
import { entries } from "../../db/schema/index.js";
import type { CommandCtx } from "../../commands/context.js";
import { getAiSettings } from "./routing.js";
import type { ToolDef } from "./llm-tools.js";
import {
  contentTypeCreate,
  contentTypeGet,
  contentTypeList,
  contentTypeUpdate,
} from "../content-type/commands.js";
import { componentCreate, componentList } from "../content-type/component-commands.js";
import { entryCreate, entryGet, entryList, entryUpdate } from "../entry/commands.js";
import { localeList } from "../locale/commands.js";
import { roleList } from "../rbac/admin-commands.js";
import { workflowGet } from "../workflow/queries.js";
import { entryAiTranslate } from "./translate-commands.js";
import { FieldType } from "@prina/shared";
import { ValidationError } from "../../lib/errors.js";

export interface AssistantTool {
  def: ToolDef;
  /** Present on executable tools; absent = proposal-only (handled by the loop) */
  run?(input: Record<string, unknown>, ctx: CommandCtx): Promise<unknown>;
}

const FIELD_ITEMS = {
  type: "array",
  items: {
    type: "object",
    description:
      "Field definition. Types: text{maxLength?,multiline?}, number{min?,max?}, boolean, date, enum{options}, json, media{multiple?,altText?}, richtext, relation{target,relationKind}, component{component}, dynamic_zone{components}",
    properties: {
      name: { type: "string", description: "snake_case field name" },
      type: { type: "string" },
      label: { type: "string" },
      required: { type: "boolean" },
      localized: { type: "boolean", description: "value differs per locale (default true for text-like fields)" },
    },
    required: ["name", "type"],
    additionalProperties: true,
  },
};

/**
 * Provenance for assistant-written entries (P3): stamp ai_draft after the save — the save
 * itself clears the mark (a human save = reviewed), so the assistant re-marks its output.
 * Cleared the same way as translation drafts: when a human saves or transitions.
 */
async function stampAssistantDraft(
  ctx: CommandCtx,
  entryId: string,
  fields: string[],
): Promise<EntryAiDraft> {
  const settings = await getAiSettings(ctx.db);
  const aiDraft: EntryAiDraft = {
    kind: "assistant",
    model: settings?.model ?? "unknown",
    createdAt: new Date().toISOString(),
    fields,
  };
  await ctx.db.update(entries).set({ aiDraft }).where(eq(entries.id, entryId));
  return aiDraft;
}

/**
 * Models keep sending plain strings for richtext fields, which the schema rightly rejects —
 * the single most common assistant write failure. Coerce top-level richtext strings into a
 * minimal ProseMirror doc (one paragraph per blank-line block) before the command validates.
 */
async function coerceRichtextValues(
  ctx: CommandCtx,
  typeUid: string,
  values: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const type = await contentTypeGet.run({ uid: typeUid }, ctx);
  const out = { ...values };
  for (const f of type.definition.fields as Array<{ name: string; type: string }>) {
    const v = out[f.name];
    if (f.type === FieldType.Richtext && typeof v === "string" && v.trim() !== "") {
      out[f.name] = {
        type: "doc",
        content: v
          .split(/\n{2,}/)
          .map((para) => para.trim())
          .filter(Boolean)
          .map((para) => ({
            type: "paragraph",
            content: [{ type: "text", text: para.replace(/\n/g, " ") }],
          })),
      };
    }
  }
  return out;
}

export function buildAssistantTools(): AssistantTool[] {
  return [
    {
      def: {
        name: "list_content_types",
        description: "List all content types with uid, name, kind and entry counts.",
        inputSchema: { type: "object", properties: {} },
      },
      run: (_i, ctx) => contentTypeList.run({}, ctx),
    },
    {
      def: {
        name: "get_content_type",
        description: "Get one content type's full definition (fields, options).",
        inputSchema: {
          type: "object",
          properties: { uid: { type: "string" } },
          required: ["uid"],
        },
      },
      run: (i, ctx) => contentTypeGet.run(i, ctx),
    },
    {
      def: {
        name: "create_content_type",
        description:
          "Create a new content type. kind: 'collection' (many entries) or 'single'. definition.fields uses the field spec; set definition.displayField to the main text field.",
        inputSchema: {
          type: "object",
          properties: {
            uid: { type: "string", description: "lowercase snake_case id" },
            name: { type: "string" },
            kind: { type: "string", enum: ["collection", "single"] },
            schemaOrgType: { type: "string", description: "schema.org type when a good match exists" },
            definition: {
              type: "object",
              properties: { displayField: { type: "string" }, fields: FIELD_ITEMS },
              required: ["fields"],
            },
          },
          required: ["uid", "name", "definition"],
        },
      },
      run: (i, ctx) => contentTypeCreate.run(i, ctx),
    },
    {
      def: {
        name: "add_fields_to_type",
        description:
          "Append new fields to an EXISTING content type. Only additions are possible — existing fields cannot be changed or removed by this tool.",
        inputSchema: {
          type: "object",
          properties: { uid: { type: "string" }, fields: FIELD_ITEMS },
          required: ["uid", "fields"],
        },
      },
      async run(i, ctx) {
        const uid = String(i.uid ?? "");
        const added = Array.isArray(i.fields) ? (i.fields as Array<{ name?: unknown }>) : [];
        if (added.length === 0) throw new ValidationError("fields must be a non-empty array");
        const current = await contentTypeGet.run({ uid }, ctx);
        const existing = new Set(current.definition.fields.map((f: { name: string }) => f.name));
        const dup = added.find((f) => existing.has(String(f.name)));
        if (dup) throw new ValidationError(`Field '${String(dup.name)}' already exists on '${uid}'`);
        // Structural guarantee of "append only": the current definition is never reshaped
        const definition = {
          ...current.definition,
          fields: [...current.definition.fields, ...added],
        };
        const updated = await contentTypeUpdate.run({ uid, definition }, ctx);
        return { uid, addedFields: added.map((f) => f.name), version: updated.version };
      },
    },
    {
      def: {
        name: "list_components",
        description: "List reusable components (for component fields and dynamic zones).",
        inputSchema: { type: "object", properties: {} },
      },
      run: (_i, ctx) => componentList.run({}, ctx),
    },
    {
      def: {
        name: "create_component",
        description:
          "Create a reusable component (usable in component fields and dynamic zones). Create components BEFORE the type that references them.",
        inputSchema: {
          type: "object",
          properties: {
            uid: { type: "string" },
            name: { type: "string" },
            definition: {
              type: "object",
              properties: { fields: FIELD_ITEMS },
              required: ["fields"],
            },
          },
          required: ["uid", "name", "definition"],
        },
      },
      run: (i, ctx) => componentCreate.run(i, ctx),
    },
    {
      def: {
        name: "list_entries",
        description: "List entries of a type (paged).",
        inputSchema: {
          type: "object",
          properties: {
            typeUid: { type: "string" },
            locale: { type: "string" },
            status: { type: "string" },
            page: { type: "number" },
          },
          required: ["typeUid"],
        },
      },
      run: (i, ctx) => entryList.run(i, ctx),
    },
    {
      def: {
        name: "get_entry",
        description: "Get one entry with its values.",
        inputSchema: {
          type: "object",
          properties: { typeUid: { type: "string" }, id: { type: "string" } },
          required: ["typeUid", "id"],
        },
      },
      run: (i, ctx) => entryGet.run(i, ctx),
    },
    {
      def: {
        name: "create_entry",
        description:
          "Create a DRAFT entry. values keys must match the type's field names. Publishing is not possible here — use propose_transition.",
        inputSchema: {
          type: "object",
          properties: {
            typeUid: { type: "string" },
            values: { type: "object" },
            locale: { type: "string" },
          },
          required: ["typeUid", "values"],
        },
      },
      async run(i, ctx) {
        const values = await coerceRichtextValues(
          ctx,
          String(i.typeUid ?? ""),
          (i.values as Record<string, unknown>) ?? {},
        );
        const out = await entryCreate.run({ ...i, values }, ctx);
        const aiDraft = await stampAssistantDraft(
          ctx,
          out.entry.id,
          Object.keys((i.values as Record<string, unknown>) ?? {}),
        );
        return { ...out, entry: { ...out.entry, aiDraft } };
      },
    },
    {
      def: {
        name: "update_entry",
        description: "Update an entry's values (partial merge — send only changed fields).",
        inputSchema: {
          type: "object",
          properties: {
            typeUid: { type: "string" },
            id: { type: "string" },
            values: { type: "object" },
          },
          required: ["typeUid", "id", "values"],
        },
      },
      async run(i, ctx) {
        const values = await coerceRichtextValues(
          ctx,
          String(i.typeUid ?? ""),
          (i.values as Record<string, unknown>) ?? {},
        );
        const out = await entryUpdate.run({ ...i, values }, ctx);
        const aiDraft = await stampAssistantDraft(
          ctx,
          out.entry.id,
          Object.keys((i.values as Record<string, unknown>) ?? {}),
        );
        return { ...out, entry: { ...out.entry, aiDraft } };
      },
    },
    {
      def: {
        name: "translate_entry",
        description:
          "AI-translate an entry into one missing locale (creates a draft sibling for human review). Call once per target locale.",
        inputSchema: {
          type: "object",
          properties: {
            typeUid: { type: "string" },
            sourceEntryId: { type: "string" },
            targetLocale: { type: "string" },
          },
          required: ["typeUid", "sourceEntryId", "targetLocale"],
        },
      },
      run: (i, ctx) => entryAiTranslate.run(i, ctx),
    },
    {
      def: {
        name: "list_locales",
        description: "List the workspace's registered locales.",
        inputSchema: { type: "object", properties: {} },
      },
      run: (_i, ctx) => localeList.run({}, ctx),
    },
    {
      def: {
        name: "list_roles",
        description: "List roles and their permissions.",
        inputSchema: { type: "object", properties: {} },
      },
      run: (_i, ctx) => roleList.run({}, ctx),
    },
    {
      def: {
        name: "get_workflow",
        description: "Get the workspace workflow (states and transitions, with any role guards).",
        inputSchema: { type: "object", properties: {} },
      },
      run: (_i, ctx) => workflowGet.run({}, ctx),
    },
    // analyze_web_page: PAUSED (2026-08-23 user decision — see the page-analysis backlog item).
    // The implementation (page-analyze.ts, provider URL readers) stays; re-register to resume.
    {
      // Proposal-only — deletion is irreversible, so the human confirms a card
      def: {
        name: "propose_delete",
        description:
          "Propose deleting an entry, content type or component. This does NOT execute — a confirmation card is shown and the human decides. Never claim something was deleted.",
        inputSchema: {
          type: "object",
          properties: {
            target: { type: "string", enum: ["entry", "content_type", "component"] },
            typeUid: { type: "string", description: "entry: its type uid / content_type·component: the uid to delete" },
            entryId: { type: "string", description: "entry target only" },
            reason: { type: "string", description: "one-line summary shown on the card" },
          },
          required: ["target", "typeUid"],
        },
      },
    },
    {
      // Proposal-only: the loop records it as a card for the human — never executed server-side
      def: {
        name: "propose_transition",
        description:
          "Propose a workflow transition (e.g. publish) for the user to confirm. This does NOT execute — a confirmation card is shown and the human decides. Use for any publish/review/approve request.",
        inputSchema: {
          type: "object",
          properties: {
            typeUid: { type: "string" },
            entryId: { type: "string" },
            to: { type: "string", description: "target status, e.g. published" },
            reason: { type: "string", description: "one-line summary shown on the card" },
          },
          required: ["typeUid", "entryId", "to"],
        },
      },
    },
  ];
}
