/** Asset grid — shared by Media Library and the picker modal (P8) */
import type { Asset } from "../../api/types";
import { IconFile, IconLink } from "@tabler/icons-react";

export function assetThumbUrl(asset: Asset): string | null {
  if (asset.renditions?.thumb) return asset.renditions.thumb;
  if (asset.mime.startsWith("image/")) return asset.downloadUrl;
  return null;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

export function AssetGrid({
  assets,
  selectedId,
  onSelect,
}: {
  assets: Asset[];
  selectedId?: string | null;
  onSelect(asset: Asset): void;
}) {
  if (assets.length === 0) {
    return <p className="muted">No assets yet. Start by uploading.</p>;
  }
  return (
    <div className="asset-grid">
      {assets.map((a) => {
        const thumb = assetThumbUrl(a);
        const kind = a.mime.split("/")[1]?.toUpperCase().slice(0, 4) ?? "FILE";
        return (
          <button
            key={a.id}
            className={selectedId === a.id ? "asset-card selected" : "asset-card"}
            onClick={() => onSelect(a)}
            title={a.filename}
          >
            <div className="asset-thumb">
              {thumb ? <img src={thumb} alt={a.filename} loading="lazy" /> : <IconFile size="2.6rem" />}
              <span className="asset-kind">{kind}</span>
            </div>
            <div className="asset-body">
              <div className="asset-name">{a.filename}</div>
              <div className="asset-dims">
                {a.width && a.height ? `${a.width}×${a.height}` : a.mime} · {formatBytes(a.size)}
              </div>
              <div className="chip-row">
                {a.usageCount !== undefined && (
                  <span
                    className={a.usageCount > 0 ? "chip chip-sm asset-inuse" : "chip chip-sm"}
                    title={a.usageCount > 0 ? `Used in ${a.usageCount} place(s)` : "Not used — safe to delete"}
                  >
                    <IconLink size="1rem" /> {a.usageCount > 0 ? `Used in ${a.usageCount}` : "Unused"}
                  </span>
                )}
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}
