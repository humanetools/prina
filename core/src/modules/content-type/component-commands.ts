/** Component CRUD commands — same pipeline as content types */
import { z } from "zod";
import { and, asc, eq } from "drizzle-orm";
import { PermissionAction, SystemSubject } from "@prina/shared";
import { components, templatePartials } from "../../db/schema/index.js";
import {
  analyzeSchemaChange,
  assertRenames,
  confirmationRequired,
  demoteBrokenEntries,
  followRenames,
  impactSummary,
  renameInEntries,
  resyncDerived,
  stampAddedAt,
  type SchemaChangeImpact,
} from "../entry/schema-issues.js";
import { defineCommand } from "../../commands/define.js";
import { validateDefinition } from "../../content/definition-validator.js";
import { ConflictError, NotFoundError, ValidationError } from "../../lib/errors.js";
import type { CommandCtx } from "../../commands/context.js";
import { effectiveMarkup, partialName } from "../template/partial-commands.js";
import { FOLDER_PATH_RE } from "../../lib/folder-path.js";
import { rememberComponentFolders } from "./component-folder-commands.js";

const uidSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_.-]{1,63}$/, "Invalid component uid format");

/** Uids shadowed by the static folder routes under /api/components (42-IMPL) — refused at creation only */
const RESERVED_UIDS = new Set(["folders", "folder-tree"]);

/** Navigation folder of a component (42-IMPL) — `/` = unfiled */
const componentFolderSchema = z.string().max(400).regex(FOLDER_PATH_RE, "Folder path format: /a/b");

/**
 * components.options (40-IMPL) — known keys validated strictly, unknown keys pass through.
 * `markup: true` makes the component a render unit: the template partial named by its uid
 * (liquid + css + js) becomes editable (CTB › component › Markup) and visible to `{% render %}`.
 */
const optionsSchema = z.object({ markup: z.boolean().optional() }).passthrough();

/** The partial name grammar is stricter than component uids (no `..`, no trailing dot) */
function assertMarkupName(uid: string, options: Record<string, unknown> | undefined) {
  if (options?.markup === true && !partialName.safeParse(uid).success) {
    throw new ValidationError(
      `Component '${uid}' cannot carry markup — its uid is not a valid partial name (lowercase segments joined by single dots)`,
    );
  }
}

/**
 * A component field that points at its own component would nest the component in itself (decided
 * 2026-11-19: not allowed). A dynamic zone that allows its own component is a different thing — a
 * container holding more containers — and stays allowed, bounded by the zone's maxDepth.
 */
function assertNotInsideItself(uid: string, definition: { fields: Array<{ name: string; type: string; component?: unknown }> }) {
  const own = definition.fields.find((f) => f.type === "component" && f.component === uid);
  if (own) throw new ValidationError(`Field '${own.name}': a component cannot contain itself`);
}

/** Current markup version per component uid — summary the list returns next to `options` */
async function loadMarkupSummaries(ctx: Pick<CommandCtx, "db" | "workspaceId">) {
  const rows = await ctx.db
    .select({
      name: templatePartials.name,
      version: templatePartials.version,
      css: templatePartials.css,
      js: templatePartials.js,
      createdAt: templatePartials.createdAt,
    })
    .from(templatePartials)
    .where(and(eq(templatePartials.workspaceId, ctx.workspaceId), eq(templatePartials.isCurrent, true)));
  return new Map(
    rows.map((r) => [
      r.name,
      { version: r.version, hasCss: r.css.trim() !== "", hasJs: r.js.trim() !== "", updatedAt: r.createdAt },
    ]),
  );
}

const componentPermission = (action: string) => () => ({
  action,
  subject: SystemSubject.Components,
});

async function getComponent(ctx: Pick<CommandCtx, "db" | "workspaceId">, uid: string) {
  const [row] = await ctx.db
    .select()
    .from(components)
    .where(and(eq(components.workspaceId, ctx.workspaceId), eq(components.uid, uid)))
    .limit(1);
  if (!row) throw new NotFoundError(`Component '${uid}' not found`);
  return row;
}

export const componentCreate = defineCommand({
  name: "component.create",
  resource: "component",
  input: z.object({
    uid: uidSchema,
    name: z.string().min(1).max(200),
    definition: z.unknown(),
    options: optionsSchema.optional(),
    folder: componentFolderSchema.optional(),
  }),
  permission: componentPermission(PermissionAction.Create),
  async execute(input, ctx) {
    if (RESERVED_UIDS.has(input.uid)) {
      throw new ValidationError(`Component uid '${input.uid}' is reserved by the API`);
    }
    const definition = validateDefinition(ctx.services.registry, input.definition, {
      isComponent: true,
    });
    assertNotInsideItself(input.uid, definition);
    assertMarkupName(input.uid, input.options);
    const [existing] = await ctx.db
      .select({ id: components.id })
      .from(components)
      .where(and(eq(components.workspaceId, ctx.workspaceId), eq(components.uid, input.uid)))
      .limit(1);
    if (existing) throw new ConflictError(`Component '${input.uid}' already exists`);
    const [row] = await ctx.db
      .insert(components)
      .values({
        workspaceId: ctx.workspaceId,
        uid: input.uid,
        name: input.name,
        definition,
        options: input.options ?? {},
        folder: input.folder ?? "/",
      })
      .returning();
    if (input.folder) await rememberComponentFolders(ctx, [input.folder]);
    return row!;
  },
  resourceId: (_i, o) => o.id,
  auditPayload: (i) => ({ uid: i.uid, markup: i.options?.markup === true, ...(i.folder ? { folder: i.folder } : {}) }),
});

export const componentUpdate = defineCommand({
  name: "component.update",
  resource: "component",
  input: z.object({
    uid: uidSchema,
    name: z.string().min(1).max(200).optional(),
    definition: z.unknown().optional(),
    /** merged into the stored options — `{ markup: true }` turns the Markup tab / partial on */
    options: optionsSchema.optional(),
    folder: componentFolderSchema.optional(),
    /** Same rule as content_type.update: a change that breaks existing entries needs this (56-IMPL) */
    confirm: z.boolean().optional(),
    /**
     * Fields that only changed their name: `{ oldName: newName }`. The values of existing entries move to
     * the new name. Without this a renamed field reads as "one removed, one added" and its values are left
     * behind (56-IMPL).
     */
    renames: z.record(z.string().min(1).max(64)).optional(),
  }),
  permission: componentPermission(PermissionAction.Update),
  async execute(input, ctx) {
    const current = await getComponent(ctx, input.uid);
    const patch: Partial<typeof components.$inferInsert> = { updatedAt: new Date() };
    let impact: SchemaChangeImpact | null = null;
    let renamed: string[] = [];
    if (input.name !== undefined) patch.name = input.name;
    const moving = input.folder !== undefined && input.folder !== current.folder;
    if (moving) patch.folder = input.folder;
    if (input.options !== undefined) {
      const merged = { ...(current.options as Record<string, unknown>), ...input.options };
      assertMarkupName(input.uid, merged);
      patch.options = merged;
    }
    if (input.definition !== undefined) {
      const renames = input.renames ?? {};
      let next = validateDefinition(ctx.services.registry, followRenames(input.definition, renames), {
        isComponent: true,
      });
      assertNotInsideItself(input.uid, next);
      assertRenames(current.definition, next, renames);
      next = stampAddedAt(current.definition, next, renames);
      patch.definition = next;
      // a rename moves the stored values first, wherever the component is used (undone if refused below)
      renamed = await renameInEntries(ctx, { componentUid: input.uid }, renames);
      // every type that uses this component, at any depth, is weighed
      impact = await analyzeSchemaChange(ctx, { componentUid: input.uid, definition: next });
      if (impact.affected > 0 && !input.confirm) throw confirmationRequired(impact);
      patch.version = current.version + 1;
      // Components are inlined into many types' compiled schemas — invalidate the whole workspace
      ctx.services.schemas.invalidateWorkspace(ctx.workspaceId);
    }
    const [updated] = await ctx.db
      .update(components)
      .set(patch)
      .where(eq(components.id, current.id))
      .returning();
    // the folder the component leaves stays in the tree; the target becomes explicit (38-IMPL D5)
    if (moving) await rememberComponentFolders(ctx, [current.folder, input.folder!]);
    await resyncDerived(ctx, renamed);
    const unpublished = impact ? await demoteBrokenEntries(ctx, impact, { kind: "component", uid: input.uid }) : 0;
    return { ...updated!, ...(impact && impact.affected > 0 ? { schemaChange: { ...impactSummary(impact), unpublished } } : {}) };
  },
  resourceId: (_i, o) => o.id,
  auditPayload: (i) => ({
    uid: i.uid,
    definitionChanged: i.definition !== undefined,
    ...(i.options?.markup !== undefined ? { markup: i.options.markup } : {}),
    ...(i.folder !== undefined ? { folder: i.folder } : {}),
  }),
});

export const componentDelete = defineCommand({
  name: "component.delete",
  resource: "component",
  input: z.object({ uid: uidSchema }),
  permission: componentPermission(PermissionAction.Delete),
  async execute(input, ctx) {
    const current = await getComponent(ctx, input.uid);
    await ctx.db.delete(components).where(eq(components.id, current.id));
    ctx.services.schemas.invalidateWorkspace(ctx.workspaceId);
    await rememberComponentFolders(ctx, [current.folder]); // its folder survives the last component
    return { id: current.id, uid: current.uid };
  },
  resourceId: (_i, o) => o.id,
  auditPayload: (i) => ({ uid: i.uid }),
});

export const componentList = defineCommand({
  name: "component.list",
  resource: "component",
  skipAudit: true,
  input: z.object({}).default({}),
  permission: componentPermission(PermissionAction.Read),
  async execute(_input, ctx) {
    const [rows, markup] = await Promise.all([
      ctx.db
        .select()
        .from(components)
        .where(eq(components.workspaceId, ctx.workspaceId))
        .orderBy(asc(components.uid)),
      loadMarkupSummaries(ctx),
    ]);
    // `markup` = the current version of the partial named by the uid (null when none was saved yet);
    // `markupEnabled` = whether a render can use it (options.markup, or legacy: a partial exists)
    const names = new Set(markup.keys());
    return rows.map((r) => ({
      ...r,
      markup: markup.get(r.uid) ?? null,
      markupEnabled: effectiveMarkup(r.uid, r.options as Record<string, unknown>, names),
    }));
  },
});
