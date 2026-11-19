/** Rendered Preview (T5.5) — current entry (incl. draft) × published template, Shadow DOM render */
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../../api/client";
import type { AuditFinding } from "../../api/types";
import { Modal } from "../../components/common/Modal";
import { DevicePicker, FramePreview, useDevicePref } from "../preview/FramePreview";
import { PreviewAssetsChip } from "../templates/PreviewAssetsChip";
import type { PreviewAsset } from "../../api/types";
import { AuditPanel } from "../preview/AuditPanel";
import {
  locateFinding,
  runShadowAudit,
  type ClientFinding,
  type PreviewRoot,
  type ShadowAuditResult,
} from "../preview/shadow-audit";


export function PreviewModal({
  typeUid,
  entryId,
  values,
  onClose,
}: {
  typeUid: string;
  /** Omitted on the create screen — the entry is not saved yet */
  entryId?: string;
  /** The form's current values (stored + unsaved edits) — previewed before any save (2026-11-04) */
  values?: Record<string, unknown>;
  onClose(): void;
}) {
  const [preview, setPreview] = useState<{
    html: string;
    css: string;
    head?: string | null;
    checks?: AuditFinding[];
    assets?: PreviewAsset[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [clientAudit, setClientAudit] = useState<ShadowAuditResult>({ findings: [], checked: 0 });
  const [device, setDevice] = useDevicePref();
  const [scale, setScale] = useState(1);
  const shadowRootRef = useRef<PreviewRoot | null>(null);
  const onRendered = useCallback((root: PreviewRoot) => {
    shadowRootRef.current = root;
    setClientAudit(runShadowAudit(root));
  }, []);

  useEffect(() => {
    api<{ html: string; css: string; head?: string | null; checks?: AuditFinding[]; assets?: PreviewAsset[] }>(
      `/api/templates/${typeUid}/preview`,
      {
        method: "POST",
        // populate mirrors delivery ?populate=1 — templates see media/relation/taxonomy the way the site does
        body: { ...(entryId ? { entryId } : {}), ...(values ? { values } : {}), populate: true },
      },
    )
      .then(setPreview)
      .catch((e) => setError(e instanceof ApiError ? e.message : "Render failed"));
    // values is re-sent only when the modal opens — the form is behind the backdrop while it is open
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typeUid, entryId]);

  return (
    <Modal
      title={values && Object.keys(values).length > 0 && !entryId ? "Rendered preview (unsaved entry)" : "Rendered preview (published template)"}
      onClose={onClose}
      wide
      headExtra={
        preview ? (
          <>
            <DevicePicker device={device} onChange={setDevice} scale={scale} />
            <PreviewAssetsChip assets={preview.assets} />
          </>
        ) : undefined
      }
    >
      {error && (
        <div className="form-error">
          {error} — If there is no template yet, create one in Edit template.
        </div>
      )}
      {preview && (
        <>
          <div className="cm-preview-render">
            <FramePreview
              html={preview.html}
              css={preview.css}
              head={preview.head}
              assets={preview.assets}
              device={device}
              onRendered={onRendered}
              onScale={setScale}
            />
          </div>
          <AuditPanel
            findings={[...(preview.checks ?? []), ...clientAudit.findings] as ClientFinding[]}
            checkedCount={clientAudit.checked}
            onLocate={(f) => shadowRootRef.current && locateFinding(shadowRootRef.current, f)}
          />
        </>
      )}
      {!preview && !error && <p className="muted">Rendering…</p>}
    </Modal>
  );
}
