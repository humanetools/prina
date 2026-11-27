/**
 * Content-type folders (38-IMPL-content-type-folders) — the CTB / CM navigation tree.
 *
 * A type's folder is the plain `content_types.folder` path. `content_type_folders` registers paths so a
 * folder can exist while empty; the tree is the union of registered paths, paths that hold types, and their
 * ancestors. Folders are scoped per kind (Collection Types and Single Types are separate trees in the
 * admin). Folders are registered when a type leaves them (`rememberTypeFolders`), so a folder never
 * disappears just because its last type moved out. Same shape and rules as the DAM folder tree (24-IMPL).
 */
import { z } from "zod";
import { and, count, eq, or, sql } from "drizzle-orm";
import { ContentTypeKind, PermissionAction, SystemSubject } from "@prina/shared";
import { contentTypeFolders, contentTypes } from "../../db/schema/index.js";
import { defineCommand } from "../../commands/define.js";
import { ConflictError, NotFoundError, ValidationError } from "../../lib/errors.js";
import type { CommandCtx } from "../../commands/context.js";
import { ancestorsOf, folderPathSchema, parentOf } from "../../lib/folder-path.js";

const ctbPermission = (action: string) => () => ({ action, subject: SystemSubject.ContentTypeBuilder });
const kindSchema = z.nativeEnum(ContentTypeKind);

/** Register paths (with their ancestors) in one kind's tree. The root is never stored. */
export async function rememberTypeFolders(ctx: CommandCtx, kind: ContentTypeKind, paths: string[]): Promise<void> {
  const all = new Set<string>();
  for (const p of paths) {
    if (p === "/") continue;
    all.add(p);
    for (const a of ancestorsOf(p)) all.add(a);
  }
  if (all.size === 0) return;
  await ctx.db
    .insert(contentTypeFolders)
    .values([...all].map((path) => ({ workspaceId: ctx.workspaceId, kind, path })))
    .onConflictDoNothing();
}

/** Every folder path of one kind except the root: registered ∪ holding types ∪ ancestors of both */
export async function collectTypeFolderPaths(ctx: CommandCtx, kind: ContentTypeKind): Promise<Set<string>> {
  const [registered, used] = await Promise.all([
    ctx.db
      .select({ path: contentTypeFolders.path })
      .from(contentTypeFolders)
      .where(and(eq(contentTypeFolders.workspaceId, ctx.workspaceId), eq(contentTypeFolders.kind, kind))),
    ctx.db
      .selectDistinct({ path: contentTypes.folder })
      .from(contentTypes)
      .where(and(eq(contentTypes.workspaceId, ctx.workspaceId), eq(contentTypes.kind, kind))),
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
const atOrUnder = (column: typeof contentTypes.folder | typeof contentTypeFolders.path, path: string) =>
  or(eq(column, path), sql`starts_with(${column}, ${`${path}/`})`)!;

/** Tree of one kind — flat, path-ordered (parents first); `count` = types directly in the folder */
export const contentTypeFolderTree = defineCommand({
  name: "content_type.folder_tree",
  resource: "content_type",
  skipAudit: true,
  input: z.object({ kind: kindSchema }),
  permission: ctbPermission(PermissionAction.Read),
  async execute(input, ctx) {
    const paths = await collectTypeFolderPaths(ctx, input.kind);
    const counts = await ctx.db
      .select({ folder: contentTypes.folder, value: count() })
      .from(contentTypes)
      .where(and(eq(contentTypes.workspaceId, ctx.workspaceId), eq(contentTypes.kind, input.kind)))
      .groupBy(contentTypes.folder);
    const countOf = new Map(counts.map((c) => [c.folder, Number(c.value)]));
    const items = [...paths].sort().map((path) => ({
      path,
      name: path.slice(path.lastIndexOf("/") + 1),
      parent: parentOf(path),
      count: countOf.get(path) ?? 0,
    }));
    return {
      kind: input.kind,
      items,
      /** types filed directly under `/` */
      rootCount: countOf.get("/") ?? 0,
      total: counts.reduce((sum, c) => sum + Number(c.value), 0),
    };
  },
});

export const contentTypeFolderCreate = defineCommand({
  name: "content_type.folder_create",
  resource: "content_type",
  input: z.object({ kind: kindSchema, path: folderPathSchema }),
  permission: ctbPermission(PermissionAction.Create),
  async execute(input, ctx) {
    if ((await collectTypeFolderPaths(ctx, input.kind)).has(input.path)) {
      throw new ConflictError(`Folder '${input.path}' already exists`);
    }
    await rememberTypeFolders(ctx, input.kind, [input.path]);
    return { kind: input.kind, path: input.path };
  },
  auditPayload: (i) => ({ kind: i.kind, path: i.path }),
});

/** Rename or move: rewrites the path prefix of the folder, everything under it, and the types inside */
export const contentTypeFolderRename = defineCommand({
  name: "content_type.folder_rename",
  resource: "content_type",
  input: z.object({ kind: kindSchema, path: folderPathSchema, newPath: folderPathSchema }),
  permission: ctbPermission(PermissionAction.Update),
  async execute(input, ctx) {
    const { kind, path, newPath } = input;
    if (newPath === path) throw new ValidationError("The new path is the same as the current one");
    if (newPath.startsWith(`${path}/`)) throw new ValidationError("A folder cannot be moved into itself");
    const existing = await collectTypeFolderPaths(ctx, kind);
    if (!existing.has(path)) throw new NotFoundError(`Folder '${path}' not found`);
    if (existing.has(newPath)) throw new ConflictError(`Folder '${newPath}' already exists`);

    const tail = path.length + 1; // substr is 1-based: what follows the old prefix
    await ctx.db
      .update(contentTypeFolders)
      .set({ path: sql`${newPath} || substr(${contentTypeFolders.path}, ${tail})` })
      .where(
        and(
          eq(contentTypeFolders.workspaceId, ctx.workspaceId),
          eq(contentTypeFolders.kind, kind),
          atOrUnder(contentTypeFolders.path, path),
        ),
      );
    const moved = await ctx.db
      .update(contentTypes)
      .set({ folder: sql`${newPath} || substr(${contentTypes.folder}, ${tail})`, updatedAt: new Date() })
      .where(
        and(eq(contentTypes.workspaceId, ctx.workspaceId), eq(contentTypes.kind, kind), atOrUnder(contentTypes.folder, path)),
      )
      .returning({ id: contentTypes.id });
    // the folder may have existed only through its types — make the new path (and its ancestors) explicit
    await rememberTypeFolders(ctx, kind, [newPath]);
    return { kind, path: newPath, previousPath: path, movedTypes: moved.length };
  },
  auditPayload: (i, o) => ({ kind: i.kind, from: i.path, to: i.newPath, movedTypes: o.movedTypes }),
});

/** Delete — only while no type is filed in the folder or anywhere under it; empty subfolders go with it */
export const contentTypeFolderDelete = defineCommand({
  name: "content_type.folder_delete",
  resource: "content_type",
  input: z.object({ kind: kindSchema, path: folderPathSchema }),
  permission: ctbPermission(PermissionAction.Delete),
  async execute(input, ctx) {
    const [held] = await ctx.db
      .select({ value: count() })
      .from(contentTypes)
      .where(
        and(
          eq(contentTypes.workspaceId, ctx.workspaceId),
          eq(contentTypes.kind, input.kind),
          atOrUnder(contentTypes.folder, input.path),
        ),
      );
    const typeCount = Number(held?.value ?? 0);
    if (typeCount > 0) {
      throw new ConflictError(
        `Folder '${input.path}' still holds ${typeCount} content type(s) (subfolders included) — move or delete them first`,
      );
    }
    const removed = await ctx.db
      .delete(contentTypeFolders)
      .where(
        and(
          eq(contentTypeFolders.workspaceId, ctx.workspaceId),
          eq(contentTypeFolders.kind, input.kind),
          atOrUnder(contentTypeFolders.path, input.path),
        ),
      )
      .returning({ path: contentTypeFolders.path });
    if (removed.length === 0) throw new NotFoundError(`Folder '${input.path}' not found`);
    return { kind: input.kind, path: input.path, removed: removed.map((r) => r.path).sort() };
  },
  auditPayload: (i, o) => ({ kind: i.kind, path: i.path, removed: o.removed.length }),
});
