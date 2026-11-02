/**
 * The CTB "Components" group as a folder tree (42-IMPL) — the component counterpart of TypeFolderGroup:
 * folders are branches with create / rename / delete, the components filed directly in a folder are its leaf
 * rows, unfiled components sit at the root. Components and folders can be dragged into a folder or onto the
 * group (→ root) — a component moves through PUT folder, a folder through the rename endpoint.
 */
import type { ReactNode } from "react";
import { api } from "../../api/client";
import type { ComponentDef } from "../../api/types";
import { useComponentFolderTree, useInvalidatingMutation } from "../../hooks/queries";
import { FolderTreeView, leafRowIndent, treeDragProps, type TreeDragItem } from "../../components/common/FolderTreeView";

export const COMPONENT_DRAG_SCOPE = "component";

/** Spread on a component row so it can be dragged within the component tree */
export const componentDragProps = (c: ComponentDef) =>
  treeDragProps({ scope: COMPONENT_DRAG_SCOPE, kind: "leaf", id: c.uid, name: c.name, parent: c.folder ?? "/" });

export function ComponentFolderGroup({
  title, components, titleExtra, renderComponent, activeUid, rootTail,
}: {
  title: string;
  /** the components in the order they should appear within each folder */
  components: ComponentDef[];
  titleExtra?: ReactNode;
  /** `indent` is the row's left padding inside the tree — undefined while the group has no folders (plain list) */
  renderComponent(component: ComponentDef, indent: string | undefined): ReactNode;
  /** the component being edited — its folder opens on arrival */
  activeUid?: string;
  /** a row drawn after the root-level components, inside the group (the "New component" button) */
  rootTail?: ReactNode;
}) {
  const { data: tree } = useComponentFolderTree();
  const invalidate = [["component-folder-tree"], ["components"]];
  const create = useInvalidatingMutation(
    (path: string) => api("/api/components/folders", { method: "POST", body: { path } }),
    invalidate,
  );
  const rename = useInvalidatingMutation(
    (v: { path: string; newPath: string }) => api("/api/components/folders", { method: "PATCH", body: v }),
    invalidate,
  );
  const remove = useInvalidatingMutation(
    (path: string) => api(`/api/components/folders?path=${encodeURIComponent(path)}`, { method: "DELETE" }),
    invalidate,
  );
  const move = useInvalidatingMutation(
    (v: { uid: string; folder: string }) => api(`/api/components/${v.uid}`, { method: "PUT", body: { folder: v.folder } }),
    invalidate,
  );
  const onMove = (item: TreeDragItem, target: string) =>
    item.kind === "leaf"
      ? move.mutateAsync({ uid: item.id, folder: target })
      : rename.mutateAsync({ path: item.id, newPath: `${target === "/" ? "" : target}/${item.name}` });

  const items = tree?.items ?? [];
  const known = new Set(items.map((f) => f.path));
  const folderOf = (c: ComponentDef) => c.folder ?? "/";
  // a component whose folder the tree does not list yet (refetch in flight) is shown at the root rather than lost
  const inFolder = (c: ComponentDef, parent: string | null) =>
    parent === null ? folderOf(c) === "/" || !known.has(folderOf(c)) : folderOf(c) === parent;
  const active = components.find((c) => c.uid === activeUid);

  return (
    <>
      <FolderTreeView
        title={title}
        titleExtra={titleExtra}
        items={items}
        autoOpen={active ? folderOf(active) : null}
        before={items.length === 0 && components.length === 0 ? <div className="nav-empty">None</div> : undefined}
        leaves={(parent, depth) => [
          ...components.filter((c) => inFolder(c, parent)).map((c) => renderComponent(c, items.length === 0 ? undefined : leafRowIndent(depth))),
          ...(parent === null && rootTail ? [rootTail] : []),
        ]}
        onCreate={(path) => create.mutateAsync(path)}
        onRename={(path, newPath) => rename.mutateAsync({ path, newPath })}
        onDelete={(path) => remove.mutateAsync(path)}
        onMove={onMove}
        dragScope={COMPONENT_DRAG_SCOPE}
      />
    </>
  );
}
