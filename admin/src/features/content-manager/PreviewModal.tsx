/** Rendered Preview (T5.5) — current entry (incl. draft) × published template, Shadow DOM render */
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../../api/client";
import type { AuditFinding } from "../../api/types";
import { Modal } from "../../components/common/Modal";
import { ShadowPreview } from "../templates/ShadowPreview";
import { AuditPanel } from "../preview/AuditPanel";
import {
  locateFinding,
  runShadowAudit,
  type ClientFinding,
  type ShadowAuditResult,
} from "../preview/shadow-audit";

export function PreviewModal({
  typeUid,
  entryId,
  onClose,
}: {
  typeUid: string;
  entryId: string;
  onClose(): void;
}) {
  const [preview, setPreview] = useState<{
    html: string;
    css: string;
    head?: string | null;
    checks?: AuditFinding[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [clientAudit, setClientAudit] = useState<ShadowAuditResult>({ findings: [], checked: 0 });
  const shadowRootRef = useRef<ShadowRoot | null>(null);
  const onRendered = useCallback((root: ShadowRoot) => {
    shadowRootRef.current = root;
    setClientAudit(runShadowAudit(root));
  }, []);

  useEffect(() => {
    api<{ html: string; css: string; head?: string | null; checks?: AuditFinding[] }>(
      `/api/templates/${typeUid}/preview`,
      {
        method: "POST",
        body: { entryId },
      },
    )
      .then(setPreview)
      .catch((e) => setError(e instanceof ApiError ? e.message : "Render failed"));
  }, [typeUid, entryId]);

  return (
    <Modal title="Rendered preview (published template)" onClose={onClose} wide>
      {error && (
        <div className="form-error">
          {error} — If there is no template yet, create one in Edit template.
        </div>
      )}
      {preview && (
        <>
          <ShadowPreview html={preview.html} css={preview.css} onRendered={onRendered} />
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
