/**
 * Component folders (42-IMPL-component-folders) — the CTB "Components" group as a folder tree, the same
 * rules as content-type folders (38-IMPL) with a single namespace instead of one per kind:
 * a component's folder is the plain `components.folder` path; `component_folders` registers paths so a
 * folder can exist while empty; the tree is the union of registered paths, paths that hold components,
 * and their ancestors. Folders are registered when a component leaves them, so a folder never disappears
 * just because its last component moved out.
 */
import { z } from "zod";
import { and, count, eq, or, sql } from "drizzle-orm";
import { PermissionAction, SystemSubject } from "@prina/shared";
import { componentFolders, components } from "../../db/schema/index.js";
import { defineCommand } from "../../commands/define.js";
import { ConflictError, NotFoundError, ValidationError } from "../../lib/errors.js";
import type { CommandCtx } from "../../commands/context.js";
import { ancestorsOf, folderPathSchema, parentOf } from "../../lib/folder-path.js";

const permission = (action: string) => () => ({ action, subject: SystemSubject.Components });

/** Register paths (with their ancestors). The root is never stored. */
export async function rememberComponentFolders(ctx: Pick<CommandCtx, "db" | "workspaceId">, paths: string[]): Promise<void> {
  const all = new Set<string>();
  for (const p of paths) {
    if (p === "/") continue;
    all.add(p);
    for (const a of ancestorsOf(p)) all.add(a);
  }
  if (all.size === 0) return;
  await ctx.db
    .insert(componentFolders)
    .values([...all].map((path) => ({ workspaceId: ctx.workspaceId, path })))
    .onConflictDoNothing();
}

/** Every folder path except the root: registered ∪ holding components ∪ ancestors of both */
export async function collectComponentFolderPaths(ctx: Pick<CommandCtx, "db" | "workspaceId">): Promise<Set<string>> {
  const [registered, used] = await Promise.all([
    ctx.db.select({ path: componentFolders.path }).from(componentFolders).where(eq(componentFolders.workspaceId, ctx.workspaceId)),
    ctx.db.selectDistinct({ path: components.folder }).from(components).where(eq(components.workspaceId, ctx.workspaceId)),
  ]);
  const out = new Set<string>();
  for (const { path } of [...registered, ...used]) {
    if (path === "/") continue;
    out.add(path);
    for (const a of ancestorsOf(path)) out.add(a);
  }
  return out;
}

/** `column` is the folder itself or sits anywhere under it — no LIKE: `_` is legal in folder names */
const atOrUnder = (column: typeof components.folder | typeof componentFolders.path, path: string) =>
  or(eq(column, path), sql`starts_with(${column}, ${`${path}/`})`)!;

/** Flat, path-ordered tree (parents first); `count` = components directly in the folder */
export const componentFolderTree = defineCommand({
  name: "component.folder_tree",
  resource: "component",
  skipAudit: true,
  input: z.object({}).default({}),
  permission: permission(PermissionAction.Read),
  async execute(_input, ctx) {
    const paths = await collectComponentFolderPaths(ctx);
    const counts = await ctx.db
      .select({ folder: components.folder, value: count() })
      .from(components)
      .where(eq(components.workspaceId, ctx.workspaceId))
      .groupBy(components.folder);
    const countOf = new Map(counts.map((c) => [c.folder, Number(c.value)]));
    const items = [...paths].sort().map((path) => ({
      path,
      name: path.slice(path.lastIndexOf("/") + 1),
      parent: parentOf(path),
      count: countOf.get(path) ?? 0,
    }));
    return {
      items,
      /** components filed directly under `/` */
      rootCount: countOf.get("/") ?? 0,
      total: counts.reduce((sum, c) => sum + Number(c.value), 0),
    };
  },
});

export const componentFolderCreate = defineCommand({
  name: "component.folder_create",
  resource: "component",
  input: z.object({ path: folderPathSchema }),
  permission: permission(PermissionAction.Create),
  async execute(input, ctx) {
    if ((await collectComponentFolderPaths(ctx)).has(input.path)) {
      throw new ConflictError(`Folder '${input.path}' already exists`);
    }
    await rememberComponentFolders(ctx, [input.path]);
    return { path: input.path };
  },
  auditPayload: (i) => ({ path: i.path }),
});

/** Rename or move: rewrites the path prefix of the folder, everything under it, and the components inside */
export const componentFolderRename = defineCommand({
  name: "component.folder_rename",
  resource: "component",
  input: z.object({ path: folderPathSchema, newPath: folderPathSchema }),
  permission: permission(PermissionAction.Update),
  async execute(input, ctx) {
    const { path, newPath } = input;
    if (newPath === path) throw new ValidationError("The new path is the same as the current one");
    if (newPath.startsWith(`${path}/`)) throw new ValidationError("A folder cannot be moved into itself");
    const existing = await collectComponentFolderPaths(ctx);
    if (!existing.has(path)) throw new NotFoundError(`Folder '${path}' not found`);
    if (existing.has(newPath)) throw new ConflictError(`Folder '${newPath}' already exists`);

    const tail = path.length + 1; // substr is 1-based: what follows the old prefix
    await ctx.db
      .update(componentFolders)
      .set({ path: sql`${newPath} || substr(${componentFolders.path}, ${tail})` })
      .where(and(eq(componentFolders.workspaceId, ctx.workspaceId), atOrUnder(componentFolders.path, path)));
    const moved = await ctx.db
      .update(components)
      .set({ folder: sql`${newPath} || substr(${components.folder}, ${tail})`, updatedAt: new Date() })
      .where(and(eq(components.workspaceId, ctx.workspaceId), atOrUnder(components.folder, path)))
      .returning({ id: components.id });
    // the folder may have existed only through its components — make the new path (and its ancestors) explicit
    await rememberComponentFolders(ctx, [newPath]);
    return { path: newPath, previousPath: path, movedComponents: moved.length };
  },
  auditPayload: (i, o) => ({ from: i.path, to: i.newPath, movedComponents: o.movedComponents }),
});

/** Delete — only while no component is filed in the folder or anywhere under it; empty subfolders go with it */
export const componentFolderDelete = defineCommand({
  name: "component.folder_delete",
  resource: "component",
  input: z.object({ path: folderPathSchema }),
  permission: permission(PermissionAction.Delete),
  async execute(input, ctx) {
    const [held] = await ctx.db
      .select({ value: count() })
      .from(components)
      .where(and(eq(components.workspaceId, ctx.workspaceId), atOrUnder(components.folder, input.path)));
    const held_n = Number(held?.value ?? 0);
    if (held_n > 0) {
      throw new ConflictError(
        `Folder '${input.path}' still holds ${held_n} component(s) (subfolders included) — move or delete them first`,
      );
    }
    const removed = await ctx.db
      .delete(componentFolders)
      .where(and(eq(componentFolders.workspaceId, ctx.workspaceId), atOrUnder(componentFolders.path, input.path)))
      .returning({ path: componentFolders.path });
    if (removed.length === 0) throw new NotFoundError(`Folder '${input.path}' not found`);
    return { path: input.path, removed: removed.map((r) => r.path).sort() };
  },
  auditPayload: (i, o) => ({ path: i.path, removed: o.removed.length }),
});
