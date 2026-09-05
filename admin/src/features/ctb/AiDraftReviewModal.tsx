/**
 * AI draft review card (T7.3, P5) — "AI goes only as far as drafts" expressed by the UI flow itself:
 * drafts arrive in a 'pending review' state; a human must edit/confirm before the type is created.
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { IconRobot } from "@tabler/icons-react";
import { api, ApiError } from "../../api/client";
import type { ContentTypeDefinition } from "../../api/types";
import { Modal } from "../../components/common/Modal";

export interface AiDraft {
  uid: string;
  name: string;
  schemaOrgType: string | null;
  definition: ContentTypeDefinition;
}

export function AiDraftReviewModal({
  draft,
  issues,
  onClose,
  onCreated,
}: {
  draft: AiDraft;
  issues: string[];
  onClose(): void;
  onCreated(uid: string): void;
}) {
  const qc = useQueryClient();
  const [uid, setUid] = useState(draft.uid);
  const [name, setName] = useState(draft.name);
  const [defText, setDefText] = useState(JSON.stringify(draft.definition, null, 2));
  const [error, setError] = useState<string[] | null>(issues.length ? issues : null);
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const definition = JSON.parse(defText);
      await api("/api/content-types", {
        method: "POST",
        body: { uid, name, schemaOrgType: draft.schemaOrgType ?? undefined, definition },
      });
      await qc.invalidateQueries({ queryKey: ["content-types"] });
      onCreated(uid);
    } catch (e) {
      if (e instanceof ApiError) {
        const d = e.details as { issues?: string[] } | null;
        setError(d?.issues ?? [e.message]);
      } else setError([e instanceof Error ? e.message : "Create failed"]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="AI schema draft — awaiting review" onClose={onClose} wide>
      <div className="ai-draft-banner">
        <IconRobot size="1.6rem" />
        This is an AI <strong>draft</strong>. Review and edit it — the type is created only when you confirm.
      </div>
      <div className="form-fields">
        <div className="row-gap">
          <label className="field" style={{ flex: 1 }}><span>uid</span>
            <input value={uid} onChange={(e) => setUid(e.target.value)} /></label>
          <label className="field" style={{ flex: 1 }}><span>Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} /></label>
        </div>
        <div className="muted">
          {draft.definition.fields?.length ?? 0} proposed fields
          {draft.schemaOrgType && <> · schema.org: <code>{draft.schemaOrgType}</code></>}
        </div>
        <label className="field"><span>Definition (editable)</span>
          <textarea className="code-area" style={{ minHeight: "26rem" }} value={defText}
            onChange={(e) => setDefText(e.target.value)} spellCheck={false} />
        </label>
        {error && (
          <div className="form-error">
            <strong>Needs review:</strong>
            <ul>{error.map((i) => <li key={i}>{i}</li>)}</ul>
          </div>
        )}
        <div className="row-gap">
          <button className="btn" onClick={onClose}>Discard</button>
          <button className="btn btn-primary" disabled={busy || !uid || !name} onClick={() => void create()}>
            {busy ? "Creating…" : "Reviewed — create type"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
