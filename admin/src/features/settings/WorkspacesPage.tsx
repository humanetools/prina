/**
 * Settings › Workspaces (48-IMPL) — instance administrators. Each workspace is a separate set of content
 * inside this install; accounts are shared. Rename keeps the slug (addresses depend on it); deleting
 * removes everything in the workspace and asks for the slug to be typed. The primary workspace stays.
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { IconPlus, IconTrash } from "@tabler/icons-react";
import { api, apiErrorMessage, getWorkspaceSlug, setWorkspaceSlug } from "../../api/client";
import { useWorkspaces } from "../../hooks/queries";
import { useAuth } from "../../auth/AuthProvider";
import { Modal } from "../../components/common/Modal";
import { NewWorkspaceModal } from "../../layout/NewWorkspaceModal";
import type { Workspace } from "../../api/types";

const PRIMARY = "default";
/** Same cap as the server (core MAX_WORKSPACES) — the server is the one that enforces it */
const MAX_WORKSPACES = 30;

export function WorkspacesPage() {
  const { state } = useAuth();
  const isInstanceAdmin = state.status === "authed" && state.me.user.isInstanceAdmin;
  const { data: workspaces } = useWorkspaces();
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Workspace | null>(null);
  const [error, setError] = useState<string | null>(null);
  const current = getWorkspaceSlug();

  const rename = async (ws: Workspace, name: string) => {
    if (!name.trim() || name.trim() === ws.name) return;
    setError(null);
    try {
      await api(`/api/workspaces/${ws.id}`, { method: "PATCH", body: { name: name.trim() } });
      await qc.invalidateQueries({ queryKey: ["workspaces"] });
    } catch (e) {
      setError(apiErrorMessage(e, "Rename failed"));
    }
  };

  if (!isInstanceAdmin) {
    return (
      <>
        <div className="page-head"><h1>Workspaces</h1></div>
        <p className="widget-hint">Workspaces are managed by instance administrators.</p>
      </>
    );
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Workspaces</h1>
          <span className="muted">Separate content (types, entries, assets, settings) in one install. Accounts are shared.</span>
        </div>
        <button
          className="btn btn-primary"
          disabled={(workspaces?.length ?? 0) >= MAX_WORKSPACES}
          title={(workspaces?.length ?? 0) >= MAX_WORKSPACES ? `Up to ${MAX_WORKSPACES} workspaces per install` : undefined}
          onClick={() => setCreating(true)}
        >
          <IconPlus size="1.5rem" /> New workspace
        </button>
      </div>
      {error && <div className="form-error" style={{ marginBottom: "var(--space-3)" }}>{error}</div>}
      <div className="ws-rows">
        {(workspaces ?? []).map((ws) => (
          <div key={ws.id} className="ws-row">
            <input
              className="ws-row-name" defaultValue={ws.name} key={`${ws.id}:${ws.name}`} aria-label="Workspace name"
              onBlur={(e) => void rename(ws, e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
            />
            <code className="ws-row-slug">{ws.slug}</code>
            <span className="ws-row-tags">
              {ws.slug === PRIMARY && <span className="ws-tag">Primary</span>}
              {ws.slug === current && <span className="ws-tag on">In use</span>}
            </span>
            {ws.slug === PRIMARY ? (
              <span className="widget-hint" title="The delivery API and the admin fall back to the primary workspace">Cannot be deleted</span>
            ) : (
              <button className="btn btn-ghost btn-icon" aria-label={`Delete ${ws.name}`} onClick={() => setDeleting(ws)}>
                <IconTrash size="1.6rem" />
              </button>
            )}
          </div>
        ))}
      </div>
      <p className="widget-hint" style={{ marginTop: "var(--space-3)" }}>
        {workspaces?.length ?? 0} of {MAX_WORKSPACES} workspaces. The slug is permanent — the delivery API (<code>?ws=</code>) and each workspace's MCP address use it.
        Click a name to rename it.
      </p>
      {creating && <NewWorkspaceModal onClose={() => setCreating(false)} />}
      {deleting && <DeleteWorkspaceModal ws={deleting} onClose={() => setDeleting(null)} />}
    </>
  );
}

function DeleteWorkspaceModal({ ws, onClose }: { ws: Workspace; onClose(): void }) {
  const qc = useQueryClient();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = async () => {
    setBusy(true); setError(null);
    try {
      await api(`/api/workspaces/${ws.id}`, { method: "DELETE", body: { confirm: typed } });
      // Leaving a deleted workspace selected would point every screen at nothing
      if (getWorkspaceSlug() === ws.slug) setWorkspaceSlug(PRIMARY);
      await qc.invalidateQueries();
      onClose();
    } catch (e) {
      setError(apiErrorMessage(e, "Delete failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Delete ${ws.name}`} onClose={onClose}>
      <p style={{ marginTop: 0 }}>
        This deletes every content type, entry, asset file, template, taxonomy, role and setting in this
        workspace, and its MCP tokens. <strong>It cannot be undone.</strong> User accounts stay.
      </p>
      <label className="field">
        <span>Type <code>{ws.slug}</code> to confirm</span>
        <input type="text" value={typed} autoFocus onChange={(e) => setTyped(e.target.value)} />
      </label>
      {error && <div className="form-error" style={{ marginTop: "var(--space-3)" }}>{error}</div>}
      <div className="row-gap" style={{ marginTop: "var(--space-5)", justifyContent: "flex-end" }}>
        <button className="btn dialog-cancel" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn btn-danger" onClick={() => void remove()} disabled={busy || typed.trim() !== ws.slug}>
          {busy ? "Deleting…" : "Delete workspace"}
        </button>
      </div>
    </Modal>
  );
}
