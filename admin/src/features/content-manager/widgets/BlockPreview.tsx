/**
 * Block markup preview (2026-11-04) — a dynamic-zone block / repeatable-component item rendered with the
 * component's partial (40-IMPL) and the values being edited, in the same popup as the entry's Rendered
 * preview (PreviewModal): iframe at a device width, site assets inlined. Media / relation / taxonomy values
 * are resolved like delivery `?populate=1`, drafts included. An editorial aid only — nothing presentational
 * is written into the content.
 */
import { useEffect, useState } from "react";
import { api } from "../../../api/client";
import type { PreviewAsset } from "../../../api/types";
import { Modal } from "../../../components/common/Modal";
import { DevicePicker, FramePreview, useDevicePref } from "../../preview/FramePreview";
import { PreviewAssetsChip } from "../../templates/PreviewAssetsChip";

export function BlockPreview({
  componentUid,
  title,
  values,
  onClose,
}: {
  componentUid: string;
  /** Component name — the popup title */
  title: string;
  values: Record<string, unknown>;
  onClose(): void;
}) {
  const [preview, setPreview] = useState<{ html: string; css: string; assets?: PreviewAsset[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [device, setDevice] = useDevicePref();
  const [scale, setScale] = useState(1);
  const body = JSON.stringify(values);

  useEffect(() => {
    let cancelled = false;
    api<{ html: string; css: string; assets?: PreviewAsset[] }>(`/api/templates/partials/${componentUid}/render`, {
      method: "POST",
      body: { values: JSON.parse(body) as Record<string, unknown>, populate: true },
    })
      .then((p) => { if (!cancelled) { setPreview(p); setError(null); } })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : "Render failed"); });
    return () => { cancelled = true; };
  }, [componentUid, body]);

  return (
    <Modal
      title={`${title} · markup preview`}
      onClose={onClose}
      wide
      headExtra={
        <>
          <DevicePicker device={device} onChange={setDevice} scale={scale} />
          {preview && <PreviewAssetsChip assets={preview.assets} />}
        </>
      }
    >
      {error && <div className="form-error">{error}</div>}
      {preview && (
        <div className="cm-preview-render">
          <FramePreview html={preview.html} css={preview.css} assets={preview.assets} device={device} onScale={setScale} />
        </div>
      )}
      {!preview && !error && <p className="muted">Rendering…</p>}
    </Modal>
  );
}
