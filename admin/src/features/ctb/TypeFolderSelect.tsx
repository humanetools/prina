/** Folder picker for a content type (38-IMPL) — the folders of the type's kind, "Unfiled" = `/` */
import type { ContentTypeKind } from "../../api/types";
import { useContentTypeFolderTree } from "../../hooks/queries";

export function TypeFolderSelect({
  kind, value, onChange, disabled = false, className,
}: {
  kind: ContentTypeKind;
  value: string;
  onChange(folder: string): void;
  disabled?: boolean;
  className?: string;
}) {
  const { data: tree } = useContentTypeFolderTree(kind);
  const paths = (tree?.items ?? []).map((f) => f.path);
  // the current folder is listed even before the tree has loaded
  const options = paths.includes(value) || value === "/" ? paths : [value, ...paths];
  return (
    <select className={className} value={value} disabled={disabled} aria-label="Folder" onChange={(e) => onChange(e.target.value)}>
      <option value="/">Unfiled</option>
      {options.map((p) => (
        <option key={p} value={p}>{p}</option>
      ))}
    </select>
  );
}
