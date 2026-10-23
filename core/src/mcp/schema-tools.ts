/**
 * Content-type (schema) tools for the management plane — the CTB surface an agent can drive.
 *
 * Create alone is not enough: an agent that mistypes a field has no way to fix it, so update
 * and delete belong here too. Deleting a type cascades to every entry of that type, and an
 * agent cannot see what it is about to destroy — so delete refuses while entries exist unless
 * the caller passes `force`, turning a silent catastrophe into a deliberate act. Permission
 * still decides who may do it at all (CTB delete is absent from the editor role).
 */
import { and, count, eq } from "drizzle-orm";
import { entries } from "../db/schema/index.js";
import type { Db } from "../db/client.js";
import type { CommandCtx, Services } from "../commands/context.js";
import { ValidationError } from "../lib/errors.js";
import { findContentTypeByUid } from "../modules/content-type/repo.js";
import {
  contentTypeCreate,
  contentTypeDelete,
  contentTypeList,
  contentTypeUpdate,
} from "../modules/content-type/commands.js";
import {
  componentCreate,
  componentDelete,
  componentList,
  componentUpdate,
} from "../modules/content-type/component-commands.js";
import type { McpToolDef } from "./tools.js";

type Json = Record<string, unknown>;
type Handler = (args: Json) => Promise<unknown>;

const UID_PATTERN = "^[a-z][a-z0-9_-]{1,63}$";

/** The definition format, spelled out — otherwise agents guess it and burn turns on retries */
function definitionSchema(fieldTypes: string[]): Json {
  return {
    type: "object",
    required: ["fields"],
    properties: {
      fields: {
        type: "array",
        maxItems: 200,
        items: {
          type: "object",
          required: ["name", "type"],
          properties: {
            name: { type: "string" },
            type: { type: "string", enum: fieldTypes },
            required: { type: "boolean" },
            options: { type: "array", items: { type: "string" }, description: "Required when type is 'enum'" },
            target: { type: "string", description: "Target content type uid — required when type is 'relation'" },
            relationKind: {
              type: "string",
              enum: ["oneToOne", "oneToMany", "manyToOne", "manyToMany"],
              description: "Required when type is 'relation'",
            },
            targetField: {
              type: "string",
              description: "For type 'uid': name of the text field to slugify from",
            },
            component: {
              type: "string",
              description:
                "Component uid — required when type is 'component'. Must already exist " +
                "(component_list / component_create); an unknown uid compiles to a field that " +
                "accepts no value. Inline definitions are not accepted here.",
            },
            repeatable: {
              type: "boolean",
              description: "For type 'component': true means the value is an array of component objects",
            },
            components: {
              type: "array",
              items: { type: "string" },
              description:
                "Component uids allowed in the zone — required when type is 'dynamic_zone'. Each " +
                "block value carries a __component discriminator naming which one it is.",
            },
            axes: {
              type: "array",
              description:
                "Required when type is 'variant_axis': [{name, options[]}] — the key is 'options', not 'values'",
              items: {
                type: "object",
                required: ["name", "options"],
                properties: {
                  name: { type: "string" },
                  options: { type: "array", items: { type: "string" } },
                },
              },
            },
          },
          additionalProperties: true,
        },
      },
      displayField: { type: "string" },
    },
  };
}

/** JSON-LD emission is driven by these two — without them a type never produces structured data */
const SCHEMA_ORG = {
  schemaOrgType: {
    type: "string",
    description:
      "schema.org type emitted as JSON-LD for entries of this type (e.g. Product, Article, " +
      "Organization, FAQPage). Delivery serves it at /delivery/{uid}/{id}?format=jsonld and " +
      "inside ?format=head. Without it the type emits no structured data.",
  },
  schemaOrgSecondary: {
    type: "string",
    description: "Optional second schema.org type for entries that are both (e.g. Product + Offer)",
  },
} as const;

/** options.seo — per-type SEO switch; also what puts a type into sitemap.xml */
const SEO_OPTIONS = {
  type: "object",
  description:
    "Per-type SEO behaviour. Set seo.enabled to give entries a SEO record (entry_set_seo) and " +
    "head emission; seo.urlPattern resolves each entry's public URL; seo.sitemap.include lists " +
    "them in /delivery/sitemap.xml.",
  properties: {
    seo: {
      type: "object",
      required: ["enabled"],
      properties: {
        enabled: { type: "boolean" },
        urlPattern: {
          type: "string",
          description:
            "Public URL path, starting with /. Tokens: {slug} (or any uid/text field name), " +
            "{id}, {locale}. A pattern with no token gives every entry the same canonical URL — " +
            "always include one.",
        },
        externalCanonicalPattern: {
          type: "string",
          description: "Absolute http(s) pattern when the canonical original lives on another site",
        },
        strictPublish: {
          type: "boolean",
          description: "Block publishing while required SEO fields are missing",
        },
        sitemap: {
          type: "object",
          required: ["include"],
          properties: {
            include: { type: "boolean" },
            priority: { type: "number", minimum: 0, maximum: 1 },
            changefreq: {
              type: "string",
              enum: ["always", "hourly", "daily", "weekly", "monthly", "yearly", "never"],
            },
          },
        },
      },
    },
  },
} as const;

const EXAMPLE =
  '{"fields":[{"name":"title","type":"text","required":true},' +
  '{"name":"status","type":"enum","options":["draft","final"]},' +
  '{"name":"brand","type":"relation","target":"brand","relationKind":"manyToOne"}],' +
  '"displayField":"title"}';

export function addSchemaTools(
  add: (tool: McpToolDef, handler: Handler) => void,
  db: Db,
  services: Services,
  ctx: CommandCtx,
): void {
  const fieldTypes = services.registry.list().map((h) => h.type);

  add(
    {
      name: "content_type_list",
      description: "List content type definitions in this workspace",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    () => contentTypeList.run({}, ctx),
  );

  add(
    {
      name: "content_type_create",
      description:
        "Create a content type (the apply step of the AI schema flow — call after human review). " +
        `Example definition: ${EXAMPLE}. After creating, use the entry_* tools with this uid right away.`,
      inputSchema: {
        type: "object",
        properties: {
          uid: { type: "string", pattern: UID_PATTERN },
          name: { type: "string" },
          kind: { type: "string", enum: ["collection", "single"] },
          description: { type: "string" },
          ...SCHEMA_ORG,
          options: SEO_OPTIONS,
          definition: definitionSchema(fieldTypes),
        },
        required: ["uid", "name", "definition"],
      },
    },
    (args) => contentTypeCreate.run(args, ctx),
  );

  add(
    {
      name: "content_type_update",
      description:
        "Change a content type — rename it, or replace its field list. `definition` is a full " +
        "replacement, not a patch: omitted fields are dropped from the schema (existing entry " +
        "values stay in storage but stop being served). Send content_type_list first and edit " +
        "the definition you get back.",
      inputSchema: {
        type: "object",
        properties: {
          uid: { type: "string", pattern: UID_PATTERN },
          name: { type: "string" },
          description: { type: "string" },
          ...SCHEMA_ORG,
          options: SEO_OPTIONS,
          definition: definitionSchema(fieldTypes),
        },
        required: ["uid"],
      },
    },
    (args) => contentTypeUpdate.run(args, ctx),
  );

  add(
    {
      name: "content_type_delete",
      description:
        "Delete a content type. This also deletes every entry of that type, permanently. " +
        "Refuses while entries exist unless force is true — check with entry_list first and " +
        "tell the user what will be lost before forcing.",
      inputSchema: {
        type: "object",
        properties: {
          uid: { type: "string", pattern: UID_PATTERN },
          force: {
            type: "boolean",
            description: "Required to delete a type that still has entries",
          },
        },
        required: ["uid"],
      },
    },
    async (args) => {
      const uid = String(args.uid ?? "");
      const type = await findContentTypeByUid(db, ctx.workspaceId, uid);
      if (!type) throw new ValidationError(`Content type '${uid}' not found`);
      if (args.force !== true) {
        const [row] = await db
          .select({ n: count() })
          .from(entries)
          .where(and(eq(entries.workspaceId, ctx.workspaceId), eq(entries.contentTypeId, type.id)));
        const n = row?.n ?? 0;
        if (n > 0) {
          throw new ValidationError(
            `'${uid}' still has ${n} entr${n === 1 ? "y" : "ies"} — deleting the type deletes them too`,
            { entryCount: n, passForceToConfirm: true },
          );
        }
      }
      return contentTypeDelete.run({ uid }, ctx);
    },
  );

  // ── Components ──────────────────────────────────────────────────────────────
  // Components live in their own table, not in content_types, so content_type_create with
  // kind "component" was never a thing. Without these tools an agent could declare a
  // `component` field but never create what it points at, and the compiled schema sealed
  // the field shut ("missing component: {uid}") — found in MCP QA, 2026-08-24.
  add(
    {
      name: "component_list",
      description:
        "List reusable component definitions. A `component` or `dynamic_zone` field can only " +
        "reference a uid that appears here.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    () => componentList.run({}, ctx),
  );

  add(
    {
      name: "component_create",
      description:
        "Create a reusable component — a named group of fields embedded into content types by a " +
        "`component` field, or offered as a block inside a `dynamic_zone`. Components are not " +
        "content types: they have no entries of their own and no uid/relation fields. Create the " +
        "component BEFORE the type that references it, or that field will accept no value.",
      inputSchema: {
        type: "object",
        properties: {
          uid: { type: "string", pattern: UID_PATTERN },
          name: { type: "string" },
          definition: definitionSchema(fieldTypes),
        },
        required: ["uid", "name", "definition"],
      },
    },
    (args) => componentCreate.run(args, ctx),
  );

  add(
    {
      name: "component_update",
      description:
        "Rename a component or replace its field list. `definition` is a full replacement, not a " +
        "patch. Every type embedding this component recompiles, so removing a field stops it " +
        "being served everywhere it was used.",
      inputSchema: {
        type: "object",
        properties: {
          uid: { type: "string", pattern: UID_PATTERN },
          name: { type: "string" },
          definition: definitionSchema(fieldTypes),
        },
        required: ["uid"],
      },
    },
    (args) => componentUpdate.run(args, ctx),
  );

  add(
    {
      name: "component_delete",
      description:
        "Delete a component definition. Types still referencing it keep the field, but it accepts " +
        "no value until the reference is removed — check component usage before deleting.",
      inputSchema: {
        type: "object",
        properties: { uid: { type: "string", pattern: UID_PATTERN } },
        required: ["uid"],
      },
    },
    (args) => componentDelete.run(args, ctx),
  );
}
