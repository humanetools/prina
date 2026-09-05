/** Asset picker modal — used by MediaWidget (T4.4) */
import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { IconUpload } from "@tabler/icons-react";
import type { Asset } from "../../api/types";
import { useAssetFolders, useAssets } from "../../hooks/queries";
import { Modal } from "../../components/common/Modal";
import { AssetGrid } from "./AssetGrid";
import { uploadFile } from "./upload";

export function AssetPickerModal({
  onPick,
  onClose,
}: {
  onPick(asset: Asset): void;
  onClose(): void;
}) {
  const [folder, setFolder] = useState("");
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const qc = useQueryClient();
  const { data: folders } = useAssetFolders();
  const { data } = useAssets({ page: "1", pageSize: "60", ...(folder ? { folder } : {}) });

  return (
    <Modal title="Select asset" onClose={onClose} wide>
      <div className="filter-bar">
        <select value={folder} onChange={(e) => setFolder(e.target.value)}>
          <option value="">All folders</option>
          {(folders ?? []).map((f) => (
            <option key={f} value={f}>{f}</option>
          ))}
        </select>
        <button className="btn btn-sm" disabled={uploading} onClick={() => fileInput.current?.click()}>
          <IconUpload size="1.4rem" /> {uploading ? "Uploading…" : "Upload new file"}
        </button>
        <input
          ref={fileInput}
          type="file"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            setUploading(true);
            uploadFile(file, folder || "/")
              .then((asset) => {
                void qc.invalidateQueries({ queryKey: ["assets"] });
                onPick(asset);
              })
              .finally(() => setUploading(false));
          }}
        />
      </div>
      <AssetGrid assets={data?.items ?? []} onSelect={onPick} />
    </Modal>
  );
}
