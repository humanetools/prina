/**
 * DAM folder tree (24-IMPL-dam-folder-tree).
 *
 * An asset's folder is the plain `assets.folder` path. `asset_folders` registers paths so a folder can
 * exist while empty; the tree is the union of registered paths, paths that hold assets, and their ancestors.
 * Folders that predate the register are not backfilled — they are registered when an asset leaves them
 * (`rememberFolders`), so a folder never disappears just because its last asset moved out.
 */
import { z } from "zod";
import { and, count, eq, or, sql } from "drizzle-orm";
import { AssetStatus, PermissionAction, SystemSubject } from "@prina/shared";
import { assetFolders, assets } from "../../db/schema/index.js";
import { defineCommand } from "../../commands/define.js";
import { ConflictError, NotFoundError, ValidationError } from "../../lib/errors.js";
import type { CommandCtx } from "../../commands/context.js";
import { ancestorsOf, folderPathSchema, parentOf } from "./folder-path.js";

const mediaPermission = (action: string) => () => ({ action, subject: SystemSubject.Media });

/** Register paths (with their ancestors). The root is never stored. */
export async function rememberFolders(ctx: CommandCtx, paths: string[]): Promise<void> {
  const all = new Set<string>();
  for (const p of paths) {
    if (p === "/") continue;
    all.add(p);
    for (const a of ancestorsOf(p)) all.add(a);
  }
  if (all.size === 0) return;
  await ctx.db
    .insert(assetFolders)
    .values([...all].map((path) => ({ workspaceId: ctx.workspaceId, path })))
    .onConflictDoNothing();
}

/** Every folder path of the workspace except the root: registered ∪ holding assets ∪ ancestors of both */
export async function collectFolderPaths(ctx: CommandCtx): Promise<Set<string>> {
  const [registered, used] = await Promise.all([
    ctx.db.select({ path: assetFolders.path }).from(assetFolders).where(eq(assetFolders.workspaceId, ctx.workspaceId)),
    ctx.db.selectDistinct({ path: assets.folder }).from(assets).where(eq(assets.workspaceId, ctx.workspaceId)),
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
const atOrUnder = (column: typeof assets.folder | typeof assetFolders.path, path: string) =>
  or(eq(column, path), sql`starts_with(${column}, ${`${path}/`})`)!;

/** Tree — flat, path-ordered (parents first); `count` = assets directly in the folder */
export const assetFolderTree = defineCommand({
  name: "asset.folder_tree",
  resource: "asset",
  skipAudit: true,
  input: z.object({}).default({}),
  permission: mediaPermission(PermissionAction.Read),
  async execute(_input, ctx) {
    const paths = await collectFolderPaths(ctx);
    const counts = await ctx.db
      .select({ folder: assets.folder, value: count() })
      .from(assets)
      .where(and(eq(assets.workspaceId, ctx.workspaceId), eq(assets.status, AssetStatus.Ready)))
      .groupBy(assets.folder);
    const countOf = new Map(counts.map((c) => [c.folder, Number(c.value)]));
    const items = [...paths].sort().map((path) => ({
      path,
      name: path.slice(path.lastIndexOf("/") + 1),
      parent: parentOf(path),
      count: countOf.get(path) ?? 0,
    }));
    return {
      items,
      /** assets filed directly under `/` */
      rootCount: countOf.get("/") ?? 0,
      total: counts.reduce((sum, c) => sum + Number(c.value), 0),
    };
  },
});

export const assetFolderCreate = defineCommand({
  name: "asset.folder_create",
  resource: "asset",
  input: z.object({ path: folderPathSchema }),
  permission: mediaPermission(PermissionAction.Create),
  async execute(input, ctx) {
    if ((await collectFolderPaths(ctx)).has(input.path)) {
      throw new ConflictError(`Folder '${input.path}' already exists`);
    }
    await rememberFolders(ctx, [input.path]);
    return { path: input.path };
  },
  auditPayload: (i) => ({ path: i.path }),
});

/** Rename or move: rewrites the path prefix of the folder, everything under it, and the assets inside */
export const assetFolderRename = defineCommand({
  name: "asset.folder_rename",
  resource: "asset",
  input: z.object({ path: folderPathSchema, newPath: folderPathSchema }),
  permission: mediaPermission(PermissionAction.Update),
  async execute(input, ctx) {
    const { path, newPath } = input;
    if (newPath === path) throw new ValidationError("The new path is the same as the current one");
    if (newPath.startsWith(`${path}/`)) throw new ValidationError("A folder cannot be moved into itself");
    const existing = await collectFolderPaths(ctx);
    if (!existing.has(path)) throw new NotFoundError(`Folder '${path}' not found`);
    if (existing.has(newPath)) throw new ConflictError(`Folder '${newPath}' already exists`);

    const tail = path.length + 1; // substr is 1-based: what follows the old prefix
    await ctx.db
      .update(assetFolders)
      .set({ path: sql`${newPath} || substr(${assetFolders.path}, ${tail})` })
      .where(and(eq(assetFolders.workspaceId, ctx.workspaceId), atOrUnder(assetFolders.path, path)));
    const moved = await ctx.db
      .update(assets)
      .set({ folder: sql`${newPath} || substr(${assets.folder}, ${tail})`, updatedAt: new Date() })
      .where(and(eq(assets.workspaceId, ctx.workspaceId), atOrUnder(assets.folder, path)))
      .returning({ id: assets.id });
    // the folder may have existed only through its assets — make the new path (and its ancestors) explicit
    await rememberFolders(ctx, [newPath]);
    return { path: newPath, previousPath: path, movedAssets: moved.length };
  },
  auditPayload: (i, o) => ({ from: i.path, to: i.newPath, movedAssets: o.movedAssets }),
});

/** Delete — only while nothing is filed in the folder or anywhere under it; empty subfolders go with it */
export const assetFolderDelete = defineCommand({
  name: "asset.folder_delete",
  resource: "asset",
  input: z.object({ path: folderPathSchema }),
  permission: mediaPermission(PermissionAction.Delete),
  async execute(input, ctx) {
    const [held] = await ctx.db
      .select({ value: count() })
      .from(assets)
      .where(and(eq(assets.workspaceId, ctx.workspaceId), atOrUnder(assets.folder, input.path)));
    const assetCount = Number(held?.value ?? 0);
    if (assetCount > 0) {
      throw new ConflictError(
        `Folder '${input.path}' still holds ${assetCount} asset(s) (subfolders included) — move or delete them first`,
      );
    }
    const removed = await ctx.db
      .delete(assetFolders)
      .where(and(eq(assetFolders.workspaceId, ctx.workspaceId), atOrUnder(assetFolders.path, input.path)))
      .returning({ path: assetFolders.path });
    if (removed.length === 0) throw new NotFoundError(`Folder '${input.path}' not found`);
    return { path: input.path, removed: removed.map((r) => r.path).sort() };
  },
  auditPayload: (i, o) => ({ path: i.path, removed: o.removed.length }),
});
