/** Content type CRUD commands (T1.3 consumer) — shared by UI (CTB) and MCP */
import { z } from "zod";
import { asc, eq, getTableColumns, sql } from "drizzle-orm";
import { ContentTypeKind, PermissionAction, SystemSubject } from "@prina/shared";
import { contentTypes } from "../../db/schema/index.js";
import { defineCommand } from "../../commands/define.js";
import { validateDefinition } from "../../content/definition-validator.js";
import { ConflictError, ValidationError } from "../../lib/errors.js";
import { FOLDER_PATH_RE } from "../../lib/folder-path.js";
import { getContentTypeByUid, findContentTypeByUid } from "./repo.js";
import { rememberTypeFolders } from "./folder-commands.js";

const uidSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{1,63}$/, "uid must start with a lowercase letter and contain only letters, digits, _ or -");

/**
 * Uids shadowed by static routes — refused at creation only: `/api/content-types/<uid>` by the folder
 * routes (38-IMPL), `/api/templates/<uid>` by the partial routes (39-IMPL)
 */
const RESERVED_UIDS = new Set(["folders", "folder-tree", "partials"]);

/** Navigation folder of a type (38-IMPL) — `/` = unfiled; a path within the tree of the type's kind */
const typeFolderSchema = z.string().max(400).regex(FOLDER_PATH_RE, "Folder path format: /a/b");

/** CTB write permission — absent from editor role (T2.2 DoD: editor's CTB command calls get 403) */
const ctbPermission = (action: string) => () => ({
  action,
  subject: SystemSubject.ContentTypeBuilder,
});

/** content_types.options — known keys validated strictly, unknown keys pass through untouched */
const seoOptionsSchema = z
  .object({
    enabled: z.boolean(),
    urlPattern: z
      .string()
      .max(500)
      .regex(/^\//, "urlPattern must start with /")
      .optional(),
    externalCanonicalPattern: z
      .string()
      .max(500)
      .regex(/^https?:\/\//, "externalCanonicalPattern must be an absolute http(s) URL")
      .optional(),
    strictPublish: z.boolean().optional(),
    sitemap: z
      .object({
        include: z.boolean(),
        priority: z.number().min(0).max(1).optional(),
        changefreq: z
          .enum(["always", "hourly", "daily", "weekly", "monthly", "yearly", "never"])
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
const optionsSchema = z.object({ seo: seoOptionsSchema.optional() }).passthrough();

export const contentTypeCreate = defineCommand({
  name: "content_type.create",
  resource: "content_type",
  input: z.object({
    uid: uidSchema,
    kind: z.nativeEnum(ContentTypeKind).default(ContentTypeKind.Collection),
    name: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
    schemaOrgType: z.string().max(200).optional(),
    schemaOrgSecondary: z.string().max(200).optional(),
    options: optionsSchema.optional(),
    definition: z.unknown(),
    folder: typeFolderSchema.optional(),
  }),
  permission: ctbPermission(PermissionAction.Create),
  async execute(input, ctx) {
    if (RESERVED_UIDS.has(input.uid)) throw new ValidationError(`'${input.uid}' is a reserved uid`);
    const definition = validateDefinition(ctx.services.registry, input.definition);
    const existing = await findContentTypeByUid(ctx.db, ctx.workspaceId, input.uid);
    if (existing) throw new ConflictError(`Content type '${input.uid}' already exists`);
    const [row] = await ctx.db
      .insert(contentTypes)
      .values({
        workspaceId: ctx.workspaceId,
        uid: input.uid,
        kind: input.kind,
        name: input.name,
        description: input.description ?? null,
        schemaOrgType: input.schemaOrgType ?? null,
        schemaOrgSecondary: input.schemaOrgSecondary ?? null,
        options: input.options ?? {},
        definition,
        folder: input.folder ?? "/",
      })
      .returning();
    if (input.folder) await rememberTypeFolders(ctx, input.kind, [input.folder]);
    ctx.services.events.emit("content-types-changed", ctx.workspaceId); // MCP listChanged (T6.2)
    return row!;
  },
  resourceId: (_i, o) => o.id,
  auditPayload: (i) => ({ uid: i.uid, kind: i.kind }),
});

export const contentTypeUpdate = defineCommand({
  name: "content_type.update",
  resource: "content_type",
  input: z.object({
    uid: uidSchema,
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).nullable().optional(),
    schemaOrgType: z.string().max(200).nullable().optional(),
    schemaOrgSecondary: z.string().max(200).nullable().optional(),
    options: optionsSchema.optional(),
    definition: z.unknown().optional(),
    folder: typeFolderSchema.optional(),
  }),
  permission: ctbPermission(PermissionAction.Update),
  async execute(input, ctx) {
    const current = await getContentTypeByUid(ctx.db, ctx.workspaceId, input.uid);
    const patch: Partial<typeof contentTypes.$inferInsert> = { updatedAt: new Date() };
    if (input.name !== undefined) patch.name = input.name;
    const moving = input.folder !== undefined && input.folder !== current.folder;
    if (moving) patch.folder = input.folder;
    if (input.description !== undefined) patch.description = input.description;
    if (input.schemaOrgType !== undefined) patch.schemaOrgType = input.schemaOrgType;
    if (input.schemaOrgSecondary !== undefined) patch.schemaOrgSecondary = input.schemaOrgSecondary;
    // Options are a top-level-key merge patch; no version bump — they never affect the compiled schema
    if (input.options !== undefined) {
      patch.options = { ...current.options, ...input.options };
    }
    if (input.definition !== undefined) {
      patch.definition = validateDefinition(ctx.services.registry, input.definition);
      patch.version = current.version + 1; // schema cache invalidation key (T1.3)
    }
    const [row] = await ctx.db
      .update(contentTypes)
      .set(patch)
      .where(eq(contentTypes.id, current.id))
      .returning();
    // the folder the type leaves stays in the tree; the target becomes explicit (38-IMPL D5)
    if (moving) await rememberTypeFolders(ctx, current.kind as ContentTypeKind, [current.folder, input.folder!]);
    ctx.services.events.emit("content-types-changed", ctx.workspaceId);
    return row!;
  },
  resourceId: (_i, o) => o.id,
  auditPayload: (i) => ({
    uid: i.uid,
    definitionChanged: i.definition !== undefined,
    ...(i.folder !== undefined ? { folder: i.folder } : {}),
  }),
});

export const contentTypeDelete = defineCommand({
  name: "content_type.delete",
  resource: "content_type",
  input: z.object({ uid: uidSchema }),
  permission: ctbPermission(PermissionAction.Delete),
  async execute(input, ctx) {
    const current = await getContentTypeByUid(ctx.db, ctx.workspaceId, input.uid);
    await ctx.db.delete(contentTypes).where(eq(contentTypes.id, current.id));
    await rememberTypeFolders(ctx, current.kind as ContentTypeKind, [current.folder]); // its folder survives the last type (38-IMPL D5)
    ctx.services.events.emit("content-types-changed", ctx.workspaceId);
    return { id: current.id, uid: current.uid };
  },
  resourceId: (_i, o) => o.id,
  auditPayload: (i) => ({ uid: i.uid }),
});

export const contentTypeGet = defineCommand({
  name: "content_type.get",
  resource: "content_type",
  skipAudit: true,
  input: z.object({ uid: uidSchema }),
  permission: ctbPermission(PermissionAction.Read),
  async execute(input, ctx) {
    return getContentTypeByUid(ctx.db, ctx.workspaceId, input.uid);
  },
});

export const contentTypeList = defineCommand({
  name: "content_type.list",
  resource: "content_type",
  skipAudit: true,
  input: z.object({}).default({}),
  permission: ctbPermission(PermissionAction.Read),
  async execute(_input, ctx) {
    return ctx.db
      .select({
        ...getTableColumns(contentTypes),
        // For CM nav counts — excludes variant children.
        // Note: in a correlated subquery ${contentTypes.id} loses its qualifier and
        // compares against e.id (same drizzle trap as asset usageCount) — use raw qualifiers.
        entryCount: sql<number>`(select count(*)::int from entries e
          where e.content_type_id = content_types.id and e.parent_entry_id is null)`,
      })
      .from(contentTypes)
      .where(eq(contentTypes.workspaceId, ctx.workspaceId))
      .orderBy(asc(contentTypes.uid));
  },
});
