/**
 * Folder tree — the file-explorer grammar shared by the Media Library (24-IMPL), the Taxonomy page and the
 * CTB / CM type navigation (38-IMPL): chevron per branch, folder icon, name, the number of items directly
 * inside on the right, hover actions (new subfolder / rename / delete), names typed in place.
 *
 * Two modes:
 * - **filter** (`onSelect` given): clicking a folder selects it, `selected` is highlighted — the Media Library.
 * - **explorer** (no `onSelect`): clicking a folder opens or closes it and `leaves` renders the rows filed
 *   directly inside, after the subfolders — the type navigation.
 *
 * Drag and drop (`onMove` given): folder rows and leaf rows (spread `treeDragProps` on them) can be dragged
 * onto a folder row (→ inside it) or onto the group's title / empty space (→ the root). Native HTML5 drag
 * events; the dragged item is kept in module state because `dataTransfer` is unreadable during dragover.
 */
import { useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import { IconFolderFilled, IconPencil, IconPlus, IconTrash } from "@tabler/icons-react";
import type { FolderNode } from "../../api/types";
import { NameInput } from "../../features/taxonomy/TaxonomyTree";

const NAME_RE = /^[a-zA-Z0-9_\-가-힣 ]+$/;
const join = (parent: string | null, name: string) => `${parent ?? ""}/${name}`;
/** `path` is `folder` or sits under it */
export const isAtOrUnder = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`);
/** `/a/b/c` → [`/a`, `/a/b`, `/a/b/c`] */
const chain = (path: string) => {
  const parts = path.split("/").filter(Boolean);
  return parts.map((_, i) => `/${parts.slice(0, i + 1).join("/")}`);
};
export const folderRowIndent = (depth: number) => `${0.4 + depth * 1.6}rem`;
/** Leaf rows carry their own icon — it lines up with the folder icon of the rows at the same depth (caret 2.2 + 0.3 + gap 0.6) */
export const leafRowIndent = (depth: number) => `${0.4 + depth * 1.6 + 3.1}rem`;

/** What is being dragged: a folder (`id` = its path) or a leaf (`id` = the caller's key); `parent` = the folder it sits in, `/` = root */
export interface TreeDragItem {
  /** trees with a different scope ignore the drag (e.g. collection vs single types) */
  scope: string;
  kind: "folder" | "leaf";
  id: string;
  name: string;
  parent: string;
}
const DRAG_MIME = "application/x-prina-tree";
let currentDrag: TreeDragItem | null = null;
const HOVER_OPEN_MS = 650;

/** Spread on a leaf row to make it draggable within its tree */
export function treeDragProps(item: TreeDragItem) {
  return {
    draggable: true,
    onDragStart(e: DragEvent<HTMLElement>) {
      currentDrag = item;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData(DRAG_MIME, JSON.stringify(item));
      e.dataTransfer.setData("text/plain", item.name);
    },
    onDragEnd() { currentDrag = null; },
  };
}

/** Can `item` land in `target` (`/` = root)? false for no-ops and for a folder moving into itself */
function canDrop(item: TreeDragItem | null, scope: string, target: string): item is TreeDragItem {
  if (!item || item.scope !== scope) return false;
  if (item.parent === target) return false;
  if (item.kind === "folder" && isAtOrUnder(target, item.id)) return false;
  return true;
}

export function FolderTreeView({
  items, title, titleExtra, newFolderLabel = "New folder", before, selected, onSelect, readOnly = false,
  onCreate, onRename, onDelete, leaves, autoOpen, onMove, dragScope = "",
}: {
  items: FolderNode[];
  title: string;
  /** rendered in the group title before the "new folder" button (e.g. a sort toggle) */
  titleExtra?: ReactNode;
  newFolderLabel?: string;
  /** fixed rows above the tree (Media Library: All / Unfiled) */
  before?: ReactNode;
  /** filter mode — the highlighted folder; null = nothing highlighted */
  selected?: string | null;
  onSelect?(folder: string): void;
  /** browse only — no create / rename / delete / drag */
  readOnly?: boolean;
  onCreate(path: string): Promise<unknown>;
  onRename(path: string, newPath: string): Promise<unknown>;
  onDelete(path: string): Promise<unknown>;
  /** explorer mode — rows filed directly in `parent` (null = the root), drawn after its subfolders */
  leaves?(parent: string | null, depth: number): ReactNode;
  /** explorer mode — a folder whose way should be open (the active item's folder) */
  autoOpen?: string | null;
  /** drag and drop — move `item` into `target` (`/` = root). Folder rows and `treeDragProps` leaves become draggable */
  onMove?(item: TreeDragItem, target: string): Promise<unknown>;
  /** identifies this tree for drags — items from a tree with another scope are refused */
  dragScope?: string;
}) {
  const explorer = !onSelect;
  const dnd = !!onMove && !readOnly;
  // branches start closed; selecting or creating a folder (or the active item) opens the way to it
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<string | null>(null);
  /** where a new folder is being typed: a parent path, or "" for the top level */
  const [draftIn, setDraftIn] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** drop target under the pointer: a folder path, "/" for the root, null = none */
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const openWay = (path: string) => setOpened((prev) => new Set([...prev, ...chain(path)]));
  useEffect(() => {
    if (autoOpen && autoOpen !== "/") openWay(autoOpen);
  }, [autoOpen]);

  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));
  const open = (path: string, value?: boolean) =>
    setOpened((prev) => {
      const next = new Set(prev);
      if (value ?? !next.has(path)) next.add(path);
      else next.delete(path);
      return next;
    });
  /** selecting opens the way to the folder once — the user can still collapse it afterwards */
  const select = (path: string) => {
    setOpened((prev) => new Set([...prev, ...chain(path).slice(0, -1)]));
    onSelect?.(path);
  };
  const activate = (path: string) => (explorer ? open(path) : select(path));
  const checked = (name: string): string | null => {
    if (NAME_RE.test(name)) return name;
    setError("Folder names take letters, digits, spaces, - and _");
    return null;
  };

  // ── drag and drop ──
  const clearHover = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
  };
  /** dragover / drop handlers for a target (`/` = root). Stops propagation so the group's root handler stays quiet */
  const dropZone = (target: string) =>
    dnd
      ? {
          onDragOver(e: DragEvent<HTMLElement>) {
            e.stopPropagation();
            if (!canDrop(currentDrag, dragScope, target)) { setDropTarget(null); return; }
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            if (dropTarget !== target) {
              setDropTarget(target);
              clearHover();
              // linger over a closed folder and it opens, so the drag can continue into its subfolders
              if (target !== "/" && !opened.has(target)) hoverTimer.current = setTimeout(() => open(target, true), HOVER_OPEN_MS);
            }
          },
          onDragLeave(e: DragEvent<HTMLElement>) {
            if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
            if (dropTarget === target) { setDropTarget(null); clearHover(); }
          },
          onDrop(e: DragEvent<HTMLElement>) {
            e.stopPropagation();
            e.preventDefault();
            setDropTarget(null);
            clearHover();
            const item = currentDrag;
            currentDrag = null;
            if (!canDrop(item, dragScope, target)) return;
            setError(null);
            onMove!(item, target).then(() => { if (target !== "/") openWay(target); }, fail);
          },
        }
      : {};
  const dropClass = (target: string) => (dropTarget === target ? " tree-drop-target" : "");

  const draftRow = (parent: string | null, depth: number) =>
    draftIn === (parent ?? "") ? (
      <div className="tax-row media-tax-row" style={{ paddingLeft: folderRowIndent(depth) }}>
        <span className="tax-caret-slot" />
        <IconFolderFilled className="media-folder-icon" size="1.6rem" />
        <NameInput
          initial=""
          onCancel={() => setDraftIn(null)}
          onCommit={(raw) => {
            setDraftIn(null);
            setError(null);
            const name = checked(raw);
            if (!name) return;
            const path = join(parent, name);
            onCreate(path).then(() => (explorer ? openWay(path) : select(path)), fail);
          }}
        />
      </div>
    ) : null;

  /** leaf rows of `parent` — wrapped so a drag over them targets the folder they sit in */
  const leafRows = (parent: string | null, depth: number) =>
    leaves ? <div {...dropZone(parent ?? "/")}>{leaves(parent, depth)}</div> : null;

  const renderLevel = (parent: string | null, depth: number): ReactNode =>
    items.filter((f) => f.parent === parent).map((f) => {
      const hasKids = items.some((c) => c.parent === f.path) || (explorer && f.count > 0);
      const expanded = opened.has(f.path);
      const active = !explorer && selected === f.path;
      return (
        <div key={f.path} role="treeitem" aria-expanded={hasKids ? expanded : undefined} aria-selected={active}>
          <div
            className={`tax-row media-tax-row media-folder-row${active ? " selected" : ""}${dropClass(f.path)}`}
            style={{ paddingLeft: folderRowIndent(depth) }}
            tabIndex={0}
            title={f.path}
            onClick={() => activate(f.path)}
            onDoubleClick={() => !readOnly && setRenaming(f.path)}
            onKeyDown={(e) => {
              if (e.target !== e.currentTarget) return;
              if (e.key === "Enter") activate(f.path);
              if (e.key === "F2" && !readOnly) setRenaming(f.path);
              if (e.key === "ArrowRight" && hasKids) open(f.path, true);
              if (e.key === "ArrowLeft" && hasKids) open(f.path, false);
            }}
            {...(dnd && renaming !== f.path
              ? treeDragProps({ scope: dragScope, kind: "folder", id: f.path, name: f.name, parent: f.parent ?? "/" })
              : {})}
            {...dropZone(f.path)}
          >
            {hasKids ? (
              <button
                type="button" className={expanded ? "tax-caret open" : "tax-caret"} aria-label={expanded ? "Collapse" : "Expand"}
                onClick={(e) => { e.stopPropagation(); open(f.path, !expanded); }}
              >
                <svg width="1rem" height="1rem" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.7">
                  <path d="M4.4 2.4 8 6l-3.6 3.6" />
                </svg>
              </button>
            ) : (
              <span className="tax-caret-slot media-folder-leaf" />
            )}
            <IconFolderFilled className="media-folder-icon" size="1.6rem" />
            {renaming === f.path ? (
              <NameInput
                initial={f.name}
                onCancel={() => setRenaming(null)}
                onCommit={(raw) => {
                  setRenaming(null);
                  setError(null);
                  const name = checked(raw);
                  if (!name) return;
                  onRename(f.path, join(f.parent, name)).catch(fail);
                }}
              />
            ) : (
              <>
                <span className="tax-name">{f.name}</span>
                <span className="nav-count">{f.count}</span>
                {!readOnly && <span className="tax-row-actions" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
                  <button className="btn btn-ghost btn-icon" title="New folder inside" onClick={() => { open(f.path, true); setDraftIn(f.path); }}>
                    <IconPlus size="1.3rem" />
                  </button>
                  <button className="btn btn-ghost btn-icon" title="Rename (F2)" onClick={() => setRenaming(f.path)}>
                    <IconPencil size="1.3rem" />
                  </button>
                  <button
                    className="btn btn-ghost btn-icon tax-del" title="Delete (empty folders only)"
                    onClick={() => {
                      setError(null);
                      if (confirm(`Delete folder '${f.path}'?`)) onDelete(f.path).catch(fail);
                    }}
                  >
                    <IconTrash size="1.3rem" />
                  </button>
                </span>}
              </>
            )}
          </div>
          {expanded && renderLevel(f.path, depth + 1)}
          {draftRow(f.path, depth + 1)}
          {expanded && leafRows(f.path, depth + 1)}
        </div>
      );
    });

  return (
    <div className={`nav-group${dropClass("/") ? " tree-drop-root" : ""}`} {...dropZone("/")}>
      <div className="nav-group-title nav-group-title-sortable">
        <span>{title}</span>
        <span className="nav-group-title-actions">
          {titleExtra}
          {!readOnly && (
            <button className="nav-sort active" title={newFolderLabel} aria-label={newFolderLabel} onClick={() => setDraftIn("")}>
              <IconPlus size="1.4rem" />
            </button>
          )}
        </span>
      </div>
      {before}
      <div role="tree">
        {renderLevel(null, 0)}
        {draftRow(null, 0)}
        {leafRows(null, 0)}
      </div>
      {error && <div className="form-error">{error}</div>}
    </div>
  );
}
