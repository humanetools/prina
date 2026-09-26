/**
 * Media Library left panel — the DAM folder tree (24-IMPL). File-explorer grammar shared with the Taxonomy
 * page: chevron per branch, folder icon, name, the number of assets directly inside on the right. Folders can
 * be created empty (at the top or inside another), renamed in place and deleted while nothing is filed under them.
 */
import { useState, type ReactNode } from "react";
import { IconFolderFilled, IconFolders, IconPencil, IconPlus, IconTrash } from "@tabler/icons-react";
import { api } from "../../api/client";
import type { AssetFolderNode, AssetFolderTree } from "../../api/types";
import { useInvalidatingMutation } from "../../hooks/queries";
import { NameInput } from "../taxonomy/TaxonomyTree";

const NAME_RE = /^[a-zA-Z0-9_\-가-힣 ]+$/;
const INVALIDATE = [["asset-folder-tree"], ["asset-folders"], ["assets"], ["asset"]];
const join = (parent: string | null, name: string) => `${parent ?? ""}/${name}`;
/** `path` is `folder` or sits under it */
export const isAtOrUnder = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`);

export function FolderTree({
  tree, selected, onSelect, onRenamed, onDeleted, readOnly = false,
}: {
  tree: AssetFolderTree | undefined;
  /** "" = All, a path = that folder, null = nothing highlighted (a taxonomy node is active) */
  selected: string | null;
  onSelect(folder: string): void;
  onRenamed?(from: string, to: string): void;
  onDeleted?(path: string): void;
  /** browse only — no create / rename / delete (asset picker) */
  readOnly?: boolean;
}) {
  // branches start closed; selecting or creating a folder opens the way to it
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<string | null>(null);
  /** where a new folder is being typed: a parent path, or "" for the top level */
  const [draftIn, setDraftIn] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const items = tree?.items ?? [];

  const onError = (e: Error) => setError(e.message);
  const create = useInvalidatingMutation((path: string) => api("/api/assets/folders", { method: "POST", body: { path } }), INVALIDATE);
  const rename = useInvalidatingMutation(
    (v: { path: string; newPath: string }) => api("/api/assets/folders", { method: "PATCH", body: v }),
    INVALIDATE,
  );
  const remove = useInvalidatingMutation(
    (path: string) => api(`/api/assets/folders?path=${encodeURIComponent(path)}`, { method: "DELETE" }),
    INVALIDATE,
  );

  const open = (path: string, value?: boolean) =>
    setOpened((prev) => {
      const next = new Set(prev);
      if (value ?? !next.has(path)) next.add(path);
      else next.delete(path);
      return next;
    });
  /** selecting opens the way to the folder once — the user can still collapse it afterwards */
  const select = (path: string) => {
    const parts = path.split("/").filter(Boolean);
    setOpened((prev) => new Set([...prev, ...parts.slice(0, -1).map((_, i) => `/${parts.slice(0, i + 1).join("/")}`)]));
    onSelect(path);
  };
  const checked = (name: string): string | null => {
    if (NAME_RE.test(name)) return name;
    setError("Folder names take letters, digits, spaces, - and _");
    return null;
  };

  const draftRow = (parent: string | null, depth: number) =>
    draftIn === (parent ?? "") ? (
      <div className="tax-row media-tax-row" style={{ paddingLeft: `${0.4 + depth * 1.6}rem` }}>
        <span className="tax-caret-slot" />
        <IconFolderFilled className="media-folder-icon" size="1.6rem" />
        <NameInput
          initial=""
          onCancel={() => setDraftIn(null)}
          onCommit={(raw) => {
            setDraftIn(null);
            setError(null);
            const name = checked(raw);
            if (name) create.mutate(join(parent, name), { onSuccess: () => select(join(parent, name)), onError });
          }}
        />
      </div>
    ) : null;

  const renderLevel = (parent: string | null, depth: number): ReactNode =>
    items.filter((f) => f.parent === parent).map((f: AssetFolderNode) => {
      const hasKids = items.some((c) => c.parent === f.path);
      const expanded = opened.has(f.path);
      const active = selected === f.path;
      return (
        <div key={f.path} role="treeitem" aria-expanded={hasKids ? expanded : undefined} aria-selected={active}>
          <div
            className={active ? "tax-row media-tax-row media-folder-row selected" : "tax-row media-tax-row media-folder-row"}
            style={{ paddingLeft: `${0.4 + depth * 1.6}rem` }}
            tabIndex={0}
            title={f.path}
            onClick={() => select(f.path)}
            onDoubleClick={() => !readOnly && setRenaming(f.path)}
            onKeyDown={(e) => {
              if (e.target !== e.currentTarget) return;
              if (e.key === "Enter") select(f.path);
              if (e.key === "F2" && !readOnly) setRenaming(f.path);
              if (e.key === "ArrowRight" && hasKids) open(f.path, true);
              if (e.key === "ArrowLeft" && hasKids) open(f.path, false);
            }}
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
                  const newPath = join(f.parent, name);
                  rename.mutate({ path: f.path, newPath }, { onSuccess: () => onRenamed?.(f.path, newPath), onError });
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
                      if (confirm(`Delete folder '${f.path}'?`)) remove.mutate(f.path, { onSuccess: () => onDeleted?.(f.path), onError });
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
        </div>
      );
    });

  // "All assets" and "Unfiled" share the folder rows' columns so the icons line up with the tree
  const fixedRow = (value: string, label: string, n: number | undefined, icon: ReactNode, title?: string) => (
    <div
      className={selected === value ? "tax-row media-tax-row media-folder-row selected" : "tax-row media-tax-row media-folder-row"}
      style={{ paddingLeft: "0.4rem" }} tabIndex={0} title={title}
      onClick={() => onSelect(value)}
      onKeyDown={(e) => { if (e.key === "Enter") onSelect(value); }}
    >
      <span className="tax-caret-slot media-folder-leaf" />
      {icon}
      <span className="tax-name">{label}</span>
      <span className="nav-count">{n ?? ""}</span>
    </div>
  );

  return (
    <div className="nav-group">
      <div className="nav-group-title nav-group-title-sortable">
        <span>Folders</span>
        {!readOnly && (
          <button className="nav-sort active" title="New folder" aria-label="New folder" onClick={() => setDraftIn("")}>
            <IconPlus size="1.4rem" />
          </button>
        )}
      </div>
      {fixedRow("", "All assets", tree?.total, <IconFolders className="media-folder-all" size="1.6rem" />)}
      {(tree?.rootCount ?? 0) > 0 &&
        fixedRow("/", "Unfiled", tree!.rootCount, <IconFolderFilled className="media-folder-icon" size="1.6rem" />, "Assets that are not in any folder")}
      <div role="tree">
        {renderLevel(null, 0)}
        {draftRow(null, 0)}
      </div>
      {error && <div className="form-error">{error}</div>}
    </div>
  );
}
