/**
 * One kind of content types ("Collection Types" / "Single Types") as a folder tree (38-IMPL): folders are
 * branches with create / rename / delete, the types filed directly in a folder are its leaf rows, unfiled
 * types sit at the root. Types and folders can be dragged into a folder or onto the group (→ root) — a type
 * moves through PUT folder, a folder through the rename endpoint with a new parent. Shared by the CTB and
 * CM context panels — they only differ in how a type row looks (spread `typeDragProps(t)` on the row).
 */
import type { ReactNode } from "react";
import { api } from "../../api/client";
import type { ContentType, ContentTypeKind } from "../../api/types";
import { useContentTypeFolderTree, useInvalidatingMutation } from "../../hooks/queries";
import { FolderTreeView, leafRowIndent, treeDragProps, type TreeDragItem } from "../../components/common/FolderTreeView";

/** Spread on a type row so it can be dragged within its kind's tree */
export const typeDragProps = (t: ContentType) =>
  treeDragProps({ scope: t.kind, kind: "leaf", id: t.uid, name: t.name, parent: t.folder });

export function TypeFolderGroup({
  kind, title, types, titleExtra, renderType, activeUid,
}: {
  kind: ContentTypeKind;
  title: string;
  /** the types of this kind, in the order they should appear within each folder */
  types: ContentType[];
  titleExtra?: ReactNode;
  /** `indent` is the row's left padding inside the tree — undefined while the group has no folders (plain list) */
  renderType(type: ContentType, indent: string | undefined): ReactNode;
  /** the type being edited / listed — its folder opens on arrival */
  activeUid?: string;
}) {
  const { data: tree } = useContentTypeFolderTree(kind);
  const invalidate = [["content-type-folder-tree", kind], ["content-types"]];
  const create = useInvalidatingMutation(
    (path: string) => api("/api/content-types/folders", { method: "POST", body: { kind, path } }),
    invalidate,
  );
  const rename = useInvalidatingMutation(
    (v: { path: string; newPath: string }) => api("/api/content-types/folders", { method: "PATCH", body: { kind, ...v } }),
    invalidate,
  );
  const remove = useInvalidatingMutation(
    (path: string) => api(`/api/content-types/folders?kind=${kind}&path=${encodeURIComponent(path)}`, { method: "DELETE" }),
    invalidate,
  );
  const moveType = useInvalidatingMutation(
    (v: { uid: string; folder: string }) => api(`/api/content-types/${v.uid}`, { method: "PUT", body: { folder: v.folder } }),
    invalidate,
  );
  const onMove = (item: TreeDragItem, target: string) =>
    item.kind === "leaf"
      ? moveType.mutateAsync({ uid: item.id, folder: target })
      : rename.mutateAsync({ path: item.id, newPath: `${target === "/" ? "" : target}/${item.name}` });

  const items = tree?.items ?? [];
  const known = new Set(items.map((f) => f.path));
  // a type whose folder the tree does not list yet (refetch in flight) is shown at the root rather than lost
  const inFolder = (t: ContentType, parent: string | null) =>
    parent === null ? t.folder === "/" || !known.has(t.folder) : t.folder === parent;
  const active = types.find((t) => t.uid === activeUid);

  return (
    <FolderTreeView
      title={title}
      titleExtra={titleExtra}
      items={items}
      autoOpen={active?.folder ?? null}
      before={items.length === 0 && types.length === 0 ? <div className="nav-empty">None</div> : undefined}
      leaves={(parent, depth) =>
        types.filter((t) => inFolder(t, parent)).map((t) => renderType(t, items.length === 0 ? undefined : leafRowIndent(depth)))}
      onCreate={(path) => create.mutateAsync(path)}
      onRename={(path, newPath) => rename.mutateAsync({ path, newPath })}
      onDelete={(path) => remove.mutateAsync(path)}
      onMove={onMove}
      dragScope={kind}
    />
  );
}
