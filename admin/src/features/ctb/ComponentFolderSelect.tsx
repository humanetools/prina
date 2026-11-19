/** Folder picker for a component (42-IMPL) — the component tree's paths, `/` = Unfiled (mirror of TypeFolderSelect) */
import { useComponentFolderTree } from "../../hooks/queries";

export function ComponentFolderSelect({
  value, onChange, disabled = false, className,
}: {
  value: string;
  onChange(folder: string): void;
  disabled?: boolean;
  className?: string;
}) {
  const { data: tree } = useComponentFolderTree();
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
