/**
 * Media Library left panel — the DAM folder tree (24-IMPL) in filter mode: "All assets" and "Unfiled" fixed
 * rows above the folders, clicking a folder selects it. The tree itself is the shared FolderTreeView
 * (also behind the CTB / CM type navigation, 38-IMPL).
 */
import { type ReactNode } from "react";
import { IconFolderFilled, IconFolders } from "@tabler/icons-react";
import { api } from "../../api/client";
import type { AssetFolderTree } from "../../api/types";
import { useInvalidatingMutation } from "../../hooks/queries";
import { FolderTreeView, isAtOrUnder } from "../../components/common/FolderTreeView";

export { isAtOrUnder };

const INVALIDATE = [["asset-folder-tree"], ["asset-folders"], ["assets"], ["asset"]];

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
  const create = useInvalidatingMutation((path: string) => api("/api/assets/folders", { method: "POST", body: { path } }), INVALIDATE);
  const rename = useInvalidatingMutation(
    (v: { path: string; newPath: string }) => api("/api/assets/folders", { method: "PATCH", body: v }),
    INVALIDATE,
  );
  const remove = useInvalidatingMutation(
    (path: string) => api(`/api/assets/folders?path=${encodeURIComponent(path)}`, { method: "DELETE" }),
    INVALIDATE,
  );

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
    <FolderTreeView
      title="Folders"
      items={tree?.items ?? []}
      selected={selected}
      onSelect={onSelect}
      readOnly={readOnly}
      before={
        <>
          {fixedRow("", "All assets", tree?.total, <IconFolders className="media-folder-all" size="1.6rem" />)}
          {(tree?.rootCount ?? 0) > 0 &&
            fixedRow("/", "Unfiled", tree!.rootCount, <IconFolderFilled className="media-folder-icon" size="1.6rem" />, "Assets that are not in any folder")}
        </>
      }
      onCreate={(path) => create.mutateAsync(path)}
      onRename={(path, newPath) => rename.mutateAsync({ path, newPath }).then(() => onRenamed?.(path, newPath))}
      onDelete={(path) => remove.mutateAsync(path).then(() => onDeleted?.(path))}
    />
  );
}
