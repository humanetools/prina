/**
 * System (P11) — version/status, license/edition, site & SEO, global dataLayer settings.
 * AI (BYOK) settings moved to Settings › AI (IMPL-ai-locale-translation).
 *
 * Edition follows the licensing contract (STRATEGY-open-source): no key = Community under
 * Apache-2.0, key present = Enterprise. So "unlicensed" is a normal state to state plainly,
 * not an error to warn about.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, getWorkspaceSlug } from "../../api/client";
import type { Ga4Market, WorkspaceSeoSettings } from "../../api/types";
import { useLicense } from "../../hooks/queries";

interface Health {
  status: string;
  db: string;
  version: string;
  uptimeSeconds: number;
}
/** Seconds → "3d 4h" / "7h 12m" / "42m" — minutes alone make big values unreadable */
function fmtUptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

const DAY = 86_400_000;
/** valid is green, grace amber, other abnormal states danger, unlicensed neutral */
const LICENSE_TONE: Record<string, string> = {
  valid: "pill-published", grace: "pill-review", unlicensed: "pill-draft",
  expired: "pill-denied", grace_expired: "pill-denied",
  revoked: "pill-denied", invalid: "pill-denied",
};

export function SystemPage() {
  const qc = useQueryClient();
  const { data: license } = useLicense();
  const { data } = useQuery({
    queryKey: ["health"],
    queryFn: () => api<Health>("/health"),
  });
  const { data: ws } = useQuery({
    queryKey: ["workspace-settings"],
    queryFn: () =>
      api<{
        settings: {
          currency?: string;
          seo?: WorkspaceSeoSettings;
          ga4Markets?: Record<string, Ga4Market>;
        };
      }>("/api/workspace-settings"),
  });
  const [currency, setCurrency] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [markets, setMarkets] = useState<Array<[string, Ga4Market]>>([]);
  const [siteBaseUrl, setSiteBaseUrl] = useState("");
  const [titleSuffix, setTitleSuffix] = useState("");
  useEffect(() => {
    if (ws) {
      setCurrency(ws.settings.currency ?? "");
      setMarkets(Object.entries(ws.settings.ga4Markets ?? {}));
      setSiteBaseUrl(ws.settings.seo?.siteBaseUrl ?? "");
      setTitleSuffix(ws.settings.seo?.titleSuffix ?? "");
    }
  }, [ws]);

  const saveMarkets = async () => {
    // settings merge is shallow — always PUT the complete ga4Markets object
    const obj = Object.fromEntries(markets.filter(([k, v]) => k && v.currency));
    await api("/api/workspace-settings", { method: "PUT", body: { settings: { ga4Markets: obj } } });
    await qc.invalidateQueries({ queryKey: ["workspace-settings"] });
    setMsg("Markets saved");
  };

  const saveSeo = async () => {
    // settings merge is shallow — always PUT the complete seo object
    const seo: WorkspaceSeoSettings = {
      ...ws?.settings.seo,
      siteBaseUrl: siteBaseUrl.replace(/\/+$/, "") || undefined,
      titleSuffix: titleSuffix || undefined,
    };
    await api("/api/workspace-settings", { method: "PUT", body: { settings: { seo } } });
    await qc.invalidateQueries({ queryKey: ["workspace-settings"] });
    setMsg("Site & SEO settings saved");
  };
  const saveCurrency = async () => {
    await api("/api/workspace-settings", {
      method: "PUT",
      body: { settings: { currency: currency || undefined } },
    });
    await qc.invalidateQueries({ queryKey: ["workspace-settings"] });
    setMsg("Currency saved");
  };

  return (
    <>
      <div className="page-head"><h1>System</h1></div>
      <table className="data-table narrow">
        <tbody>
          <tr><th>Core version</th><td><code>{data?.version ?? "…"}</code></td></tr>
          <tr><th>API status</th><td>{data?.status ?? "…"}</td></tr>
          <tr><th>Database</th><td>{data?.db ?? "…"}</td></tr>
          <tr><th>Uptime</th><td>{data ? fmtUptime(data.uptimeSeconds) : "…"}</td></tr>
          {(() => {
            const st = license?.state;
            if (!st) return <tr><th>Edition</th><td className="muted">…</td></tr>;
            const oss = st.status === "unlicensed";
            const days = st.expiresAt === null ? null : Math.ceil((st.expiresAt - Date.now()) / DAY);
            return (
              <>
                <tr>
                  <th>Edition</th>
                  <td>
                    <span className={`pill ${LICENSE_TONE[st.status] ?? "pill-draft"}`}>
                      {oss ? "Community" : "Enterprise"}
                    </span>
                    {oss ? (
                      <a
                        href="https://www.apache.org/licenses/LICENSE-2.0"
                        target="_blank" rel="noreferrer"
                        style={{ marginLeft: "var(--space-2)" }}
                      >
                        Apache-2.0
                      </a>
                    ) : (
                      <span className="muted" style={{ marginLeft: "var(--space-2)" }}>{st.status}</span>
                    )}
                  </td>
                </tr>
                {oss && (
                  <tr><th>Terms</th><td className="muted">
                    Free to use, modify and self-host. Enterprise features activate with a license key.
                  </td></tr>
                )}
                {st.customer && <tr><th>Licensed to</th><td>{st.customer}</td></tr>}
                {st.plan && <tr><th>Plan</th><td>{st.plan}</td></tr>}
                {st.expiresAt !== null && (
                  <tr>
                    <th>Expires</th>
                    <td>
                      <code>{new Date(st.expiresAt).toISOString().slice(0, 10)}</code>
                      <span
                        className="muted"
                        style={{ marginLeft: "var(--space-2)", color: days !== null && days <= 30 ? "var(--danger)" : undefined }}
                      >
                        {days === null ? "" : days >= 0 ? `${days} days left` : `expired ${-days} days ago`}
                      </span>
                    </td>
                  </tr>
                )}
                {st.reason && <tr><th>Reason</th><td className="muted">{st.reason}</td></tr>}
                {st.lastServerOkAt !== null && (
                  <tr><th>Last verified</th><td className="muted">
                    {new Date(st.lastServerOkAt).toISOString().slice(0, 16).replace("T", " ")} · {st.source}
                  </td></tr>
                )}
                {st.updateAvailable && st.latestPatch && (
                  <tr><th>Update</th><td>
                    <span className={st.latestCritical ? "pill pill-denied" : "pill pill-review"}>
                      {st.latestPatch} available
                    </span>
                  </td></tr>
                )}
              </>
            );
          })()}
        </tbody>
      </table>

      <h3 className="section-title" style={{ marginTop: "var(--space-5)" }}>
        Site &amp; SEO
      </h3>
      <div className="form-fields narrow">
        <label className="field"><span>Site base URL</span>
          <input placeholder="https://example.com" value={siteBaseUrl}
            onChange={(e) => setSiteBaseUrl(e.target.value)} /></label>
        <label className="field"><span>Title suffix</span>
          <input placeholder=" | Brand" value={titleSuffix}
            onChange={(e) => setTitleSuffix(e.target.value)} /></label>
        <div className="row-gap">
          <button className="btn" onClick={() => void saveSeo()}>Save</button>
        </div>
        <p className="widget-hint">
          Base URL + each type's URL pattern (Content-Type Builder › SEO) form entry canonical
          URLs; the suffix is appended to meta titles.
        </p>
        <div className="field">
          <span>Public surfaces</span>
          {["sitemap.xml", "robots.txt", "llms.txt"].map((f) => {
            const url = `${window.location.origin}/delivery/${f}?ws=${getWorkspaceSlug()}`;
            return (
              <div className="row-gap" key={f} style={{ marginTop: "0.6rem" }}>
                <code style={{ userSelect: "all" }}>{url}</code>
                <button
                  className="btn btn-sm"
                  onClick={() => { void navigator.clipboard.writeText(url); setMsg(`${f} URL copied`); }}
                >
                  Copy
                </button>
              </div>
            );
          })}
          <p className="widget-hint">
            sitemap lists published entries of types with "Include in sitemap"; llms.txt is a
            content survey for AI agents (GEO).
          </p>
        </div>
      </div>

      <h3 className="section-title" style={{ marginTop: "var(--space-5)" }}>
        dataLayer defaults (GA4)
      </h3>
      <div className="row-gap">
        <input placeholder="Currency code (e.g. KRW)" maxLength={3} value={currency}
          onChange={(e) => setCurrency(e.target.value.toUpperCase())} />
        <button className="btn" onClick={() => void saveCurrency()}>Save</button>
      </div>
      <p className="widget-hint">Fallback currency — used when a request resolves to no market.</p>

      <h3 className="section-title" style={{ marginTop: "var(--space-5)" }}>
        Markets (per-country GTM · currency)
      </h3>
      <p className="widget-hint">
        When each country installs its own GTM container and prices in its own currency, list
        the markets here. Delivery resolves one per request: <code>?market=</code> first, then
        the entry's locale, then the fallback above. The container id is emitted with the
        payload so the page can verify it is running under the container it was served for.
      </p>
      <table className="data-table narrow">
        <thead>
          <tr><th>Market (locale or country)</th><th>Currency</th><th>GTM container</th><th /></tr>
        </thead>
        <tbody>
          {markets.map(([key, m], i) => (
            <tr key={i}>
              <td>
                <input value={key} placeholder="ko / us / de"
                  onChange={(e) => setMarkets(markets.map((r, j) => (j === i ? [e.target.value.trim(), r[1]] : r)))} />
              </td>
              <td>
                <input value={m.currency} maxLength={3} placeholder="KRW" style={{ width: "10rem" }}
                  onChange={(e) => setMarkets(markets.map((r, j) => (j === i ? [r[0], { ...r[1], currency: e.target.value.toUpperCase() }] : r)))} />
              </td>
              <td>
                <input value={m.containerId ?? ""} placeholder="GTM-XXXXXXX"
                  onChange={(e) => setMarkets(markets.map((r, j) => (j === i ? [r[0], { ...r[1], containerId: e.target.value || undefined }] : r)))} />
              </td>
              <td className="col-actions">
                <button className="btn btn-ghost btn-sm" onClick={() => setMarkets(markets.filter((_, j) => j !== i))}>
                  Remove
                </button>
              </td>
            </tr>
          ))}
          {markets.length === 0 && (
            <tr><td colSpan={4} className="muted">No markets — one currency for the whole site.</td></tr>
          )}
        </tbody>
      </table>
      <div className="row-gap" style={{ marginTop: "var(--space-3)" }}>
        <button className="btn" onClick={() => setMarkets([...markets, ["", { currency: "" }]])}>
          Add market
        </button>
        <button className="btn btn-primary" onClick={() => void saveMarkets()}>Save markets</button>
      </div>

      <h3 className="section-title" style={{ marginTop: "var(--space-5)" }}>
        AI
      </h3>
      <p className="widget-hint">
        AI settings (Anthropic BYOK, semantic search embeddings) moved to{" "}
        <Link to="/settings/ai">Settings › AI</Link>.
      </p>
      {msg && <span className="muted">{msg}</span>}
    </>
  );
}
