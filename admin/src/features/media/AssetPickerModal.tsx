/**
 * Asset picker (25-IMPL) — used by media fields and the SEO image. Browses the library the way the Media
 * Library does: folder tree and taxonomy trees on the left (read-only, single-select), filename search,
 * pages. When the entry being edited is classified, its nodes show up as chips and the first one filters
 * the grid up front — unless nothing is classified there yet. Files uploaded here land in the selected
 * folder and take the entry's classification.
 */
import { useContext, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { IconUpload } from "@tabler/icons-react";
import { api } from "../../api/client";
import type { Asset } from "../../api/types";
import { useAssetFolderTree, useAssets } from "../../hooks/queries";
import { Modal } from "../../components/common/Modal";
import { EntryClassificationContext } from "../content-manager/EntryClassificationContext";
import { AssetGrid } from "./AssetGrid";
import { FolderTree } from "./FolderTree";
import { TaxonomyFilter, type TaxonomyFilterValue } from "./TaxonomyFilter";
import { uploadFile } from "./upload";

const PAGE_SIZE = 60;

export function AssetPickerModal({
  onPick,
  onClose,
}: {
  onPick(asset: Asset): void;
  onClose(): void;
}) {
  const entryNodes = useContext(EntryClassificationContext);
  const [folder, setFolder] = useState("");
  const [taxonomy, setTaxonomy] = useState<TaxonomyFilterValue | null>(
    entryNodes[0] ? { spec: entryNodes[0].spec, label: entryNodes[0].name } : null,
  );
  // true while the taxonomy filter is the one applied on open, not one the user chose
  const [auto, setAuto] = useState(entryNodes.length > 0);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const qc = useQueryClient();

  const { data: folderTree } = useAssetFolderTree();
  const { data } = useAssets({
    page: String(page),
    pageSize: String(PAGE_SIZE),
    ...(folder ? { folder } : {}),
    ...(taxonomy ? { taxonomy: taxonomy.spec } : {}),
    ...(search ? { search } : {}),
  });
  const total = data?.pagination.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // An entry can be classified before any asset is: opening on an empty grid would read as "no assets".
  // Only the up-front filter is dropped — a filter the user picked stays, even when it matches nothing.
  useEffect(() => {
    if (!auto || !data) return;
    if (data.pagination.total === 0) setTaxonomy(null);
    setAuto(false);
  }, [auto, data]);

  // the rail is single-select, like the Media Library: a folder or a taxonomy node
  const pickFolder = (f: string) => { setAuto(false); setFolder(f); setTaxonomy(null); setPage(1); };
  const pickTaxonomy = (next: TaxonomyFilterValue | null) => { setAuto(false); setTaxonomy(next); if (next) setFolder(""); setPage(1); };

  const upload = async (file: File) => {
    setUploading(true);
    setError(null);
    try {
      const asset = await uploadFile(file, folder || "/");
      if (entryNodes.length > 0) {
        // classification is a convenience — the upload and the pick stand even if this fails
        await api(`/api/assets/${asset.id}/taxonomies`, { method: "PUT", body: { nodeIds: entryNodes.map((n) => n.nodeId) } }).catch(() => undefined);
      }
      for (const key of [["assets"], ["asset-folders"], ["asset-folder-tree"]]) void qc.invalidateQueries({ queryKey: key });
      onPick(asset);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  return (
    <Modal title="Select asset" onClose={onClose} wide>
      <div className="asset-picker">
        <aside className="asset-picker-rail">
          <FolderTree tree={folderTree} selected={taxonomy ? null : folder} onSelect={pickFolder} readOnly />
          <TaxonomyFilter value={taxonomy} onChange={pickTaxonomy} />
        </aside>

        <div className="asset-picker-main">
          <div className="asset-picker-bar">
            <div className="search-box">
              <svg width="1.4rem" height="1.4rem" viewBox="0 0 14 14" fill="none" stroke="var(--text-3)" strokeWidth="1.6">
                <circle cx="6.2" cy="6.2" r="4" />
                <path d="M9.2 9.2 12 12" />
              </svg>
              <input
                placeholder="Search file names — press Enter"
                autoFocus
                // Uncontrolled: the DOM owns the text until the user submits with Enter (IME-safe)
                defaultValue={search}
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  setAuto(false);
                  setSearch(e.currentTarget.value.trim());
                  setPage(1);
                }}
              />
            </div>
            <span className="muted asset-picker-count">
              {data ? `${total} assets` : "…"}{folder && ` · ${folder}`}{taxonomy && ` · ${taxonomy.label}`}{search && ` · “${search}”`}
            </span>
            <button className="btn btn-sm" disabled={uploading} onClick={() => fileInput.current?.click()}>
              <IconUpload size="1.4rem" /> {uploading ? "Uploading…" : "Upload new file"}
            </button>
            <input ref={fileInput} type="file" hidden onChange={(e) => { const file = e.target.files?.[0]; if (file) void upload(file); }} />
          </div>

          {entryNodes.length > 0 && (
            <div className="asset-picker-entry">
              <span className="muted">This entry</span>
              {entryNodes.map((n) => {
                const active = taxonomy?.spec === n.spec;
                return (
                  <button
                    key={n.nodeId} type="button" className={active ? "chip chip-sm asset-picker-chip active" : "chip chip-sm asset-picker-chip"}
                    aria-pressed={active} title={active ? "Show all assets" : `Show assets classified under ${n.name}`}
                    onClick={() => pickTaxonomy(active ? null : { spec: n.spec, label: n.name })}
                  >
                    {n.name}
                  </button>
                );
              })}
              <span className="widget-hint">New uploads get this classification{folder ? ` and go to ${folder}` : ""}.</span>
            </div>
          )}
          {error && <div className="form-error">{error}</div>}

          <div className="asset-picker-grid">
            {data && total === 0 ? (
              <p className="tax-empty">No assets here{search ? ` match “${search}”` : ""}.</p>
            ) : (
              <AssetGrid assets={data?.items ?? []} onSelect={onPick} />
            )}
          </div>

          {pageCount > 1 && (
            <div className="pagination asset-picker-pages">
              <button className="btn btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Prev</button>
              <span>{page} / {pageCount}</span>
              <button className="btn btn-sm" disabled={page >= pageCount} onClick={() => setPage(page + 1)}>Next</button>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
