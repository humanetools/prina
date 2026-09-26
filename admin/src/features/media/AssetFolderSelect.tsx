/** Asset detail panel — move the asset to another folder (24-IMPL). Saves on change. */
import { api } from "../../api/client";
import type { AssetDetail, AssetFolderTree } from "../../api/types";
import { useInvalidatingMutation } from "../../hooks/queries";

export function AssetFolderSelect({ asset, tree }: { asset: AssetDetail; tree: AssetFolderTree | undefined }) {
  const move = useInvalidatingMutation(
    (folder: string) => api(`/api/assets/${asset.id}`, { method: "PATCH", body: { folder } }),
    [["asset", asset.id], ["assets"], ["asset-folder-tree"], ["asset-folders"]],
  );
  const paths = (tree?.items ?? []).map((f) => f.path);
  return (
    <label className="asset-folder-select">
      <span className="panel-title">Folder</span>
      <select value={asset.folder} disabled={move.isPending} onChange={(e) => move.mutate(e.target.value)}>
        <option value="/">Unfiled</option>
        {/* the asset's own folder is listed even before the tree has loaded */}
        {(paths.includes(asset.folder) || asset.folder === "/" ? paths : [asset.folder, ...paths]).map((p) => (
          <option key={p} value={p}>{p}</option>
        ))}
      </select>
      {move.error && <div className="form-error">{move.error.message}</div>}
    </label>
  );
}
