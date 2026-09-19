/** Agents & tokens (P10) — stat cards + per-plane token cards (2 columns) */
import { useState } from "react";
import { copyText } from "../../hooks/clipboard";
import { IconCopy, IconPlus } from "@tabler/icons-react";
import { api, ApiError } from "../../api/client";
import type { McpToken } from "../../api/types";
import { Link } from "react-router-dom";
import { ScopeChips } from "./ScopeMatrix";
import { GrantChips } from "../settings/GrantRows";
import { useInvalidatingMutation, useMcpTokens, useRoles } from "../../hooks/queries";
import { Modal } from "../../components/common/Modal";
import { formatDate } from "../content-manager/format";

export function TokensSection() {
  const { data: tokens } = useMcpTokens();
  const { data: roles } = useRoles();
  const [createOpen, setCreateOpen] = useState(false);
  const [issued, setIssued] = useState<string | null>(null);

  const revoke = useInvalidatingMutation(
    (id: string) => api(`/api/mcp/tokens/${id}`, { method: "DELETE" }),
    [["mcp-tokens"]],
  );

  const active = (tokens ?? []).filter((t) => !t.revokedAt);
  const stats: Array<[string, string]> = [
    ["Active Agent", String(active.length)],
    ["Management", String(active.filter((t) => t.plane === "management").length)],
    ["Delivery", String(active.filter((t) => t.plane === "delivery").length)],
    ["Revoked", String((tokens ?? []).length - active.length)],
  ];

  const roleName = (id: string | null) =>
    roles?.find((r) => r.id === id)?.name ?? (id ? id.slice(0, 8) : "—");

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Agents · tokens</h1>
          <span className="muted">
            AI agents operate through MCP with the same permission model as people — and a narrower ceiling.
          </span>
        </div>
        <button className="btn btn-primary" onClick={() => setCreateOpen(true)}>
          <IconPlus size="1.5rem" /> Issue token
        </button>
      </div>

      <div className="stat-grid">
        {stats.map(([label, value]) => (
          <div key={label} className="stat-card">
            <div className="stat-label">{label}</div>
            <div className="stat-value">{value}</div>
          </div>
        ))}
      </div>

      <div className="token-grid">
        {(tokens ?? []).map((tk: McpToken) => (
          <div key={tk.id} className={tk.revokedAt ? "token-card revoked" : "token-card"}>
            <div className="token-head">
              <span className="token-dot" />
              <span className="token-plane">{tk.plane}</span>
              <span style={{ flex: 1 }} />
              <span className={tk.revokedAt ? "pill pill-draft" : "pill pill-published"}>
                {tk.revokedAt ? "Revoked" : "Active"}
              </span>
            </div>
            <div className="token-name">mcp:{tk.name}</div>
            <div className="token-meta">
              <div className="token-meta-row">
                <span>role mapping</span>
                <span>{tk.plane === "management" ? roleName(tk.roleId) : "read-only"}</span>
              </div>
              <div className="token-meta-row">
                <span>{tk.plane === "management" ? "API access" : "scope"}</span>
                {tk.plane === "management" ? (
                  tk.grants && tk.grants.length > 0
                    ? <GrantChips grants={tk.grants} />
                    : tk.scopes && Object.keys(tk.scopes).length > 0
                      ? <ScopeChips scopes={tk.scopes} />
                      : <span className="muted">MCP only</span>
                ) : (
                  <span>{`published${tk.localeScope ? ` · ${tk.localeScope}` : ""}`}</span>
                )}
              </div>
              <div className="token-meta-row">
                <span>last used</span>
                <span>{tk.lastUsedAt ? formatDate(tk.lastUsedAt) : "Unused"}</span>
              </div>
            </div>
            {!tk.revokedAt && (
              <div className="token-actions">
                <button
                  className="btn btn-danger"
                  onClick={() => {
                    if (confirm(`Revoke the token '${tk.name}'?`)) revoke.mutate(tk.id);
                  }}
                >
                  Revoke
                </button>
              </div>
            )}
          </div>
        ))}
        {(tokens ?? []).length === 0 && (
          <div className="empty-state">
            <p>No tokens issued yet.</p>
          </div>
        )}
      </div>

      <p className="widget-hint" style={{ marginTop: "var(--space-4)" }}>
        Endpoints: <code>POST /mcp/management</code> · <code>POST /mcp/delivery</code>
        {" "}(Streamable HTTP, Authorization: Bearer).
        Management follows the bound role's permissions and workflow guards —
        "AI up to draft" is configured by removing publish from the role.
      </p>
      <p className="widget-hint">
        Tokens issued here are for MCP agents and carry no REST access. For external admin pages and
        integrations that call the REST API, issue an <Link to="/settings/access-tokens">access token</Link>
        (Settings › Access tokens) — same credential type, with resource × read/edit scopes.
      </p>

      {createOpen && (
        <CreateTokenModal
          onClose={() => setCreateOpen(false)}
          onIssued={(token) => { setIssued(token); setCreateOpen(false); }}
        />
      )}
      {issued && (
        <Modal title="Token issued — shown only now" onClose={() => setIssued(null)}>
          <p className="widget-hint">This token is shown only once. Store it somewhere safe.</p>
          <div className="row-gap" style={{ marginTop: "var(--space-3)" }}>
            <code className="mono" style={{ wordBreak: "break-all" }}>{issued}</code>
            <button className="btn btn-sm" onClick={() => void copyText(issued)}>
              <IconCopy size="1.4rem" />
            </button>
          </div>

        </Modal>
      )}
    </>
  );
}

function CreateTokenModal({
  onClose,
  onIssued,
}: {
  onClose(): void;
  onIssued(token: string): void;
}) {
  const { data: roles } = useRoles();
  const [form, setForm] = useState({ plane: "management", name: "", roleId: "" });
  const [error, setError] = useState<string | null>(null);
  // MCP-only: scopes {} — REST access is issued in Settings › Access tokens
  const create = useInvalidatingMutation(
    () =>
      api<{ token: string }>("/api/mcp/tokens", {
        method: "POST",
        body: {
          plane: form.plane,
          name: form.name,
          ...(form.plane === "management" ? { roleId: form.roleId, scopes: {} } : {}),
        },
      }),
    [["mcp-tokens"]],
  );

  return (
    <Modal title="Issue MCP token" onClose={onClose}>
      <div className="form-fields">
        <label className="field"><span>Plane</span>
          <select value={form.plane} onChange={(e) => setForm({ ...form, plane: e.target.value })}>
            <option value="management">Management (operations — write)</option>
            <option value="delivery">Delivery (serving — read only)</option>
          </select>
        </label>
        <label className="field"><span>Agent name (recorded as mcp:name in the audit log)</span>
          <input value={form.name} placeholder="e.g. ops-01"
            onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </label>
        {form.plane === "management" && (
          <>
            <label className="field"><span>Role binding (runs with these permissions)</span>
              <select value={form.roleId} onChange={(e) => setForm({ ...form, roleId: e.target.value })}>
                <option value="">Select…</option>
                {(roles ?? []).map((r) => (
                  <option key={r.id} value={r.id}>{r.name}</option>
                ))}
              </select>
            </label>
          </>
        )}
        {error && <div className="form-error">{error}</div>}
        <button className="btn btn-primary btn-block"
          disabled={!form.name || (form.plane === "management" && !form.roleId)}
          onClick={() =>
            create.mutate(undefined, {
              onSuccess: (r) => onIssued(r.token),
              onError: (e) => setError(e instanceof ApiError ? e.message : "Issue failed"),
            })
          }>
          Issue
        </button>
      </div>
    </Modal>
  );
}
