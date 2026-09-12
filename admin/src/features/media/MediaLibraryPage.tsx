/** Media Library (P8, T4.4) — folder panel + grid + upload + asset details */
import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { IconFolder, IconTrash, IconUpload } from "@tabler/icons-react";
import { api, ApiError } from "../../api/client";
import { useAsset, useAssetFolders, useAssets, useInvalidatingMutation } from "../../hooks/queries";
import { SectionLayout } from "../../layout/SectionLayout";
import { EmptyHero, MediaArt } from "../../components/common/EmptyHero";
import { StatusChipList } from "./MediaDetailBits";
import { AltTextInput } from "./AltTextInput";
import { ContrastBlock } from "./ContrastBlock";
import { AssetGrid, assetThumbUrl, formatBytes } from "./AssetGrid";
import { uploadFile } from "./upload";
import { formatDate, displayValue } from "../content-manager/format";

export function MediaLibraryPage() {
  const [folder, setFolder] = useState<string>("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const qc = useQueryClient();

  const { data: folders } = useAssetFolders();
  const { data } = useAssets({ page: "1", pageSize: "60", ...(folder ? { folder } : {}) });
  const { data: detail } = useAsset(selectedId ?? undefined);

  const doUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    setError(null);
    try {
      for (const file of files) {
        await uploadFile(file, folder || "/");
      }
      await qc.invalidateQueries({ queryKey: ["assets"] });
      await qc.invalidateQueries({ queryKey: ["asset-folders"] });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const remove = useInvalidatingMutation(
    (id: string) => api(`/api/assets/${id}`, { method: "DELETE" }),
    [["assets"], ["asset-folders"]],
  );

  const panel = (
    <div className="nav-group">
      <button className={folder === "" ? "nav-item active" : "nav-item"} onClick={() => setFolder("")}>
        <span><IconFolder size="1.4rem" /> All</span>
      </button>
      {(folders ?? []).map((f) => (
        <button key={f} className={folder === f ? "nav-item active" : "nav-item"} onClick={() => setFolder(f)}>
          <span><IconFolder size="1.4rem" /> {f}</span>
        </button>
      ))}
    </div>
  );

  return (
    <SectionLayout
      panelTitle="Media Library"
      panel={panel}
      rightPanel={
        detail ? (
          <aside className="right-panel">
            <section className="panel-section">
              <div className="asset-preview">
                {assetThumbUrl(detail) ? (
                  <img src={detail.renditions?.medium ?? detail.downloadUrl} alt={detail.filename} />
                ) : (
                  <span className="muted">{detail.mime}</span>
                )}
              </div>
              <div className="panel-title">{detail.filename}</div>
              <div className="muted">
                {formatBytes(detail.size)}
                {detail.width && ` · ${detail.width}×${detail.height}`} · {formatDate(detail.createdAt)}
              </div>
              {Object.keys(detail.metadata).length > 0 && (
                <div className="mono" style={{ fontSize: "1.1rem", color: "var(--text-3)" }}>
                  {Object.entries(detail.metadata)
                    .filter(([k]) => k !== "analysis") // rendered as the Overlay contrast section
                    .slice(0, 5)
                    .map(([k, v]) => `${k}: ${String(v)}`).join(" · ")}
                </div>
              )}
            </section>

            {/* a11y (WCAG 1.1.1) — one description per asset, reused by every usage */}
            <section className="panel-section">
              <div className="panel-title">Accessibility</div>
              <AltTextInput asset={detail} />
            </section>

            <ContrastBlock detail={detail} />

            <section className="panel-section">
              <div className="panel-title">Renditions</div>
              {detail.renditions ? (
                <StatusChipList items={Object.keys(detail.renditions)} />
              ) : (
                <p className="widget-hint">imgproxy not configured — serving originals only</p>
              )}
            </section>

            <section className="panel-section">
              <div className="panel-title">Used by ({detail.usages.length})</div>
              {detail.usages.length === 0 ? (
                <p className="widget-hint">Not used — safe to delete</p>
              ) : (
                <ul className="activity-list">
                  {detail.usages.map((u) => (
                    <li key={`${u.entryId}:${u.field}`}>
                      <Link to={`/content/${u.typeUid}/${u.entryId}`}>
                        {u.typeName} · {displayValue(Object.values(u.entryValues)[0])}
                      </Link>
                      <code className="muted">{u.field}</code>
                    </li>
                  ))}
                </ul>
              )}
              <button
                className="btn btn-danger btn-block"
                disabled={!detail.deletable}
                title={detail.deletable ? "" : "Assets in use cannot be deleted"}
                onClick={() => {
                  if (confirm(`Delete '${detail.filename}'?`)) {
                    remove.mutate(detail.id, { onSuccess: () => setSelectedId(null) });
                  }
                }}
              >
                <IconTrash size="1.5rem" /> Delete
              </button>
            </section>
          </aside>
        ) : undefined
      }
    >
      <div>
        <div>
          <div className="page-head">
            <div>
              <h1>Media Library</h1>
              <span className="muted">{data?.pagination.total ?? "…"} assets{folder && ` · ${folder}`}</span>
            </div>
            <button className="btn btn-primary" disabled={uploading} onClick={() => fileInput.current?.click()}>
              <IconUpload size="1.5rem" /> {uploading ? "Uploading…" : "Upload"}
            </button>
            <input ref={fileInput} type="file" multiple hidden onChange={(e) => void doUpload(e.target.files)} />
          </div>
          {error && <div className="form-error">{error}</div>}
          {data && data.pagination.total === 0 && !folder ? (
            <EmptyHero
              art={<MediaArt />}
              title="No assets yet"
              copy="Upload images and files once, reuse them across entries — usage is tracked and renditions are generated automatically."
              actions={
                <button className="btn btn-primary" disabled={uploading} onClick={() => fileInput.current?.click()}>
                  <IconUpload size="1.5rem" /> {uploading ? "Uploading…" : "Upload files"}
                </button>
              }
            />
          ) : (
            <AssetGrid
              assets={data?.items ?? []}
              selectedId={selectedId}
              onSelect={(a) => setSelectedId(a.id === selectedId ? null : a.id)}
            />
          )}
        </div>

      </div>
    </SectionLayout>
  );
}
