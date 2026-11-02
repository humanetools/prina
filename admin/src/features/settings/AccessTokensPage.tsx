/**
 * Settings › Access tokens (20-IMPL) — REST credentials for external admin pages and integrations.
 * Same records as the MCP console's management tokens; this view is the REST-facing one: issue with
 * a resource × Read/Edit matrix, list the tokens that carry any API access.
 */
import { useState } from "react";
import { IconCopy, IconPlus } from "@tabler/icons-react";
import { api, ApiError } from "../../api/client";
import { ApiScope, ApiScopeLevel, type ApiScopes, type McpToken } from "../../api/types";
import { useContentTypes, useInvalidatingMutation, useMcpTokens, useRoles } from "../../hooks/queries";
import { describeGrants, emptyRow, GrantChips, GrantRows, rowsToGrants, type GrantRow } from "./GrantRows";
import { copyText } from "../../hooks/clipboard";
import { DataTable } from "../../components/common/DataTable";
import { formatDate } from "../content-manager/format";
import { clampScopes, describeScopes, roleScopeCeiling, ScopeChips, ScopeMatrix } from "../mcp/ScopeMatrix";

const hasApiAccess = (tk: McpToken) =>
  tk.plane === "management" && ((!!tk.grants && tk.grants.length > 0) || (!!tk.scopes && Object.keys(tk.scopes).length > 0));

export function AccessTokensPage() {
  const { data: tokens } = useMcpTokens();
  const { data: roles } = useRoles();
  const [issuing, setIssuing] = useState(false);
  const [issued, setIssued] = useState<string | null>(null);
  const revoke = useInvalidatingMutation(
    (id: string) => api(`/api/mcp/tokens/${id}`, { method: "DELETE" }),
    [["mcp-tokens"]],
  );
  const list = (tokens ?? []).filter(hasApiAccess);
  const roleName = (id: string | null) => roles?.find((r) => r.id === id)?.name ?? (id ? id.slice(0, 8) : "—");

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Access tokens</h1>
          <span className="muted">
            Credentials for external admin pages and integrations calling the REST API (<code>/api/*</code>).
            A token reaches only what it was granted; inside that, permissions apply as for any user.
          </span>
        </div>
        {!issuing && (
          <button className="btn btn-primary" onClick={() => { setIssued(null); setIssuing(true); }}>
            <IconPlus size="1.5rem" /> Issue token
          </button>
        )}
      </div>

      {issuing && (
        <IssueAccessTokenForm
          onCancel={() => setIssuing(false)}
          onIssued={(token) => { setIssued(token); setIssuing(false); }}
        />
      )}

      {issued && (
        <div className="token-issued">
          <div className="token-issued-title">Token issued — shown only now. Store it somewhere safe.</div>
          <div className="row-gap">
            <code className="mono" style={{ wordBreak: "break-all" }}>{issued}</code>
            <button className="btn btn-sm" onClick={() => void copyText(issued)}><IconCopy size="1.4rem" /></button>
            <button className="btn btn-sm" onClick={() => setIssued(null)}>Done</button>
          </div>
          <code className="mono widget-hint" style={{ display: "block", wordBreak: "break-all" }}>
            {`curl ${window.location.origin}/api/content-types -H "Authorization: Bearer ${issued.slice(0, 12)}…"`}
          </code>
        </div>
      )}

      <section style={{ marginTop: "var(--space-5)" }}>
        <DataTable
          columns={[
            { key: "name", title: "Name", sortValue: (tk) => tk.name, render: (tk) => <span className="mono">{tk.name}</span> },
            {
              key: "status", title: "Status", width: "9rem", sortValue: (tk) => (tk.revokedAt ? 1 : 0),
              render: (tk) => <span className={tk.revokedAt ? "pill pill-draft" : "pill pill-published"}>{tk.revokedAt ? "Revoked" : "Active"}</span>,
            },
            {
              key: "mode", title: "Permissions", sortValue: (tk) => (tk.grants?.length ? "custom" : roleName(tk.roleId)),
              render: (tk) => (
                <div className="token-perm-cell">
                  {tk.grants?.length ? <GrantChips grants={tk.grants} /> : <><span className="chip chip-sm">role · {roleName(tk.roleId)}</span><ScopeChips scopes={tk.scopes} /></>}
                </div>
              ),
            },
            { key: "lastUsed", title: "Last used", width: "14rem", sortValue: (tk) => tk.lastUsedAt ?? "", render: (tk) => (tk.lastUsedAt ? formatDate(tk.lastUsedAt) : <span className="muted">Unused</span>) },
            { key: "created", title: "Created", width: "14rem", sortValue: (tk) => tk.createdAt, render: (tk) => formatDate(tk.createdAt) },
            {
              key: "actions", title: "", width: "9rem", stopRowClick: true,
              render: (tk) => tk.revokedAt ? null : (
                <button className="link-btn danger" onClick={() => { if (confirm(`Revoke the token '${tk.name}'?`)) revoke.mutate(tk.id); }}>Revoke</button>
              ),
            },
          ]}
          rows={list}
          rowKey={(tk) => tk.id}
          emptyText="No access tokens yet. Issue one to let an external system call the API."
        />
      </section>

      <p className="widget-hint" style={{ marginTop: "var(--space-4)" }}>
        Send <code>Authorization: Bearer pmt_mgmt_…</code> from your backend (not the browser — CORS is not enabled).
        Outside the token's permissions the API answers <code>403 SCOPE_DENIED</code>. The audit log records calls as <code>api:&lt;name&gt;</code>.
        Full spec: <code>/openapi.json</code>.
      </p>
    </>
  );
}

type Mode = "role" | "custom";

function IssueAccessTokenForm({ onCancel, onIssued }: { onCancel(): void; onIssued(token: string): void }) {
  const { data: roles } = useRoles();
  const { data: contentTypes } = useContentTypes();
  const [mode, setMode] = useState<Mode>("custom");
  const [rows, setRows] = useState<GrantRow[]>([emptyRow()]);
  const grants = rowsToGrants(rows);
  const [name, setName] = useState("");
  const [roleId, setRoleId] = useState("");
  const [scopes, setScopes] = useState<ApiScopes>({ [ApiScope.Content]: ApiScopeLevel.Edit });
  const role = roles?.find((r) => r.id === roleId);
  // The role caps the matrix: levels it cannot back are disabled, and switching roles drops grants it cannot honour
  const ceiling = roleScopeCeiling(role);
  const pickRole = (id: string) => {
    setRoleId(id);
    setScopes((s) => clampScopes(s, roleScopeCeiling(roles?.find((r) => r.id === id))));
  };
  const [error, setError] = useState<string | null>(null);
  const create = useInvalidatingMutation(
    () =>
      api<{ token: string }>("/api/mcp/tokens", {
        method: "POST",
        body: mode === "custom"
          ? { plane: "management", name, grants }
          : { plane: "management", name, roleId, scopes },
      }),
    [["mcp-tokens"]],
  );
  const noScopes = Object.keys(scopes).length === 0;
  const canIssue = !!name && (mode === "custom" ? grants.length > 0 : !!roleId && !noScopes);
  return (
    <section className="token-issue">
      <div className="token-issue-head">
        <h3 className="section-title" style={{ marginBottom: 0 }}>Issue access token</h3>
        <button className="btn btn-sm" onClick={onCancel}>Cancel</button>
      </div>
      <div className="form-fields">
        <label className="field"><span>Token name (audit log shows api:name)</span>
          <input value={name} placeholder="e.g. shop-admin" onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="field">
          <span>Permissions</span>
          <div className="seg" role="group" aria-label="Permission mode">
            <button type="button" className={mode === "custom" ? "active" : ""} onClick={() => setMode("custom")}>Custom</button>
            <button type="button" className={mode === "role" ? "active" : ""} onClick={() => setMode("role")}>From a role</button>
          </div>
        </div>
        {mode === "custom" && (
          <div className="field">
            <span className="widget-hint" style={{ fontWeight: 400 }}>Select edit or read permissions for this token. You can only grant what your own account can do.</span>
            <GrantRows rows={rows} onChange={setRows} contentTypes={contentTypes} />
            {grants.length > 0 && <div className="widget-hint scope-summary">This token can {describeGrants(grants)}.</div>}
          </div>
        )}
        {mode === "role" && (<>
        <label className="field"><span>Role (permissions inside the granted groups)</span>
          <select value={roleId} onChange={(e) => pickRole(e.target.value)}>
            <option value="">Select…</option>
            {(roles ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </label>
        <div className="field">
          <span>API access</span>
          <ScopeMatrix value={scopes} onChange={setScopes} ceiling={ceiling} roleName={role?.name} />
          <div className={noScopes ? "widget-hint scope-summary danger" : "widget-hint scope-summary"}>
            {noScopes ? "Pick at least one group." : `This token can ${describeScopes(scopes)}.`}
          </div>
        </div>
        </>)}
        {error && <div className="form-error">{error}</div>}
        <div className="row-gap">
          <button className="btn btn-primary" disabled={!canIssue}
            onClick={() => create.mutate(undefined, { onSuccess: (r) => onIssued(r.token), onError: (e) => setError(e instanceof ApiError ? e.message : "Issue failed") })}>
            Issue token
          </button>
          <button className="btn" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </section>
  );
}
