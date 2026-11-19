/**
 * Pick a component — the component folders (42-IMPL) on the left, the components of the chosen folder on
 * the right. Used where a dynamic zone gets another allowed component: the folders that organise components
 * in the CTB navigation organise them here too. Same two-pane shape as the asset picker; the tree is read-only.
 */
import { useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { IconFolderFilled, IconFolders, IconPlus, IconX } from "@tabler/icons-react";
import { FieldType, type ComponentDef } from "../../api/types";
import { useComponentFolderTree } from "../../hooks/queries";
import { FieldTypeTile } from "../../components/common/FieldTypeTile";
import { FolderTreeView, isAtOrUnder } from "../../components/common/FolderTreeView";

const noop = () => Promise.resolve();
const ALL = "";
const UNFILED = "/";

export function ComponentPickerModal({
  title, subtitle, components, emptyText, onPick, onCreate, onClose,
}: {
  title: string;
  subtitle?: string;
  /** the components that can be picked (already filtered by the caller) */
  components: ComponentDef[];
  /** shown when there is nothing to pick at all */
  emptyText: string;
  onPick(component: ComponentDef): void;
  /** "Create a new component" — omitted where creating is not offered */
  onCreate?(): void;
  onClose(): void;
}) {
  const { data: tree } = useComponentFolderTree();
  const [folder, setFolder] = useState<string>(ALL);

  const items = tree?.items ?? [];
  const known = new Set(items.map((f) => f.path));
  // A component whose folder the tree does not list (refetch in flight) counts as unfiled rather than lost
  const folderOf = (c: ComponentDef) => (c.folder && c.folder !== UNFILED && known.has(c.folder) ? c.folder : UNFILED);
  const directCount = (path: string) => components.filter((c) => folderOf(c) === path).length;
  // The tree's own counts include components that cannot be picked here — show what this picker offers
  const counted = items.map((f) => ({ ...f, count: directCount(f.path) }));
  const unfiled = directCount(UNFILED);

  const shown = components.filter((c) =>
    folder === ALL ? true : folder === UNFILED ? folderOf(c) === UNFILED : isAtOrUnder(folderOf(c), folder),
  );
  // Grouped by folder, in the tree's order; unfiled first
  const groups = [UNFILED, ...items.map((f) => f.path)]
    .map((path) => ({ path, list: shown.filter((c) => folderOf(c) === path) }))
    .filter((g) => g.list.length > 0);

  const fixedRow = (value: string, label: string, n: number, icon: ReactNode) => (
    <div
      className={folder === value ? "tax-row media-tax-row media-folder-row selected" : "tax-row media-tax-row media-folder-row"}
      style={{ paddingLeft: "0.4rem" }} tabIndex={0}
      onClick={() => setFolder(value)}
      onKeyDown={(e) => { if (e.key === "Enter") setFolder(value); }}
    >
      <span className="tax-caret-slot media-folder-leaf" />
      {icon}
      <span className="tax-name">{label}</span>
      <span className="nav-count">{n}</span>
    </div>
  );

  // At the document root: it also opens from inside the field dialog, whose box clips its children
  return createPortal(
    <div className="fm-backdrop fm-backdrop-top" onClick={(e) => { e.stopPropagation(); onClose(); }}>
      <div className="fm fm-picker" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <div className="fm-head">
          <div style={{ flex: 1 }}>
            <div className="fm-title">{title}</div>
            {subtitle && <div className="fm-sub">{subtitle}</div>}
          </div>
          <button className="fm-close" onClick={onClose} aria-label="Close">
            <IconX size="1.3rem" />
          </button>
        </div>
        <div className="fm-picker-body">
          <div className="fm-picker-rail">
            <FolderTreeView
              title="Folders"
              items={counted}
              selected={folder}
              onSelect={setFolder}
              readOnly
              before={
                <>
                  {fixedRow(ALL, "All components", components.length, <IconFolders className="media-folder-all" size="1.6rem" />)}
                  {unfiled > 0 && fixedRow(UNFILED, "Unfiled", unfiled, <IconFolderFilled className="media-folder-icon" size="1.6rem" />)}
                </>
              }
              onCreate={noop} onRename={noop} onDelete={noop}
            />
          </div>
          <div className="fm-picker-list">
            {groups.map((g) => (
              <div key={g.path} className="fm-picker-group">
                {(groups.length > 1 || g.path !== UNFILED) && (
                  <div className="fm-picker-group-title">{g.path === UNFILED ? "Unfiled" : g.path.replace(/^\//, "").split("/").join(" / ")}</div>
                )}
                {g.list.map((c) => (
                  <button key={c.uid} className="opt-card" onClick={() => onPick(c)}>
                    <FieldTypeTile type={FieldType.Component} />
                    <span className="opt-card-text">
                      <span className="opt-card-name">{c.name}</span>
                      <span className="opt-card-desc">{c.definition.fields.length} fields · {c.uid}</span>
                    </span>
                  </button>
                ))}
              </div>
            ))}
            {components.length === 0 && <div className="fm-info">{emptyText}</div>}
            {components.length > 0 && shown.length === 0 && <div className="fm-info">No component to add in this folder.</div>}
          </div>
        </div>
        {onCreate && (
          <div className="fm-foot">
            <button className="btn" onClick={onCreate}>
              <IconPlus size="1.4rem" /> Create a new component
            </button>
            <span className="fm-foot-spacer" />
            <button className="btn dialog-cancel" onClick={onClose}>Cancel</button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
