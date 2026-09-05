/**
 * Template editor (P7, T5.3) — 3 file tabs + analytics events tab, script.js lock, live preview.
 * Renders in two modes: its own route page, or embedded in the CTB "Templates" tab
 * (2026-08-22 — the tab used to be a dead end with just a link). Fullscreen lifts the
 * embedded editor over the shell without navigating, so unsaved edits survive.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  IconArrowsMaximize,
  IconArrowsMinimize,
  IconDeviceFloppy,
} from "@tabler/icons-react";
import { api, ApiError } from "../../api/client";
import type { AuditFinding, Ga4Config } from "../../api/types";
import { AuditPanel } from "../preview/AuditPanel";
import {
  locateFinding,
  runShadowAudit,
  type ClientFinding,
  type ShadowAuditResult,
} from "../preview/shadow-audit";
import {
  useContentTypes,
  useEntries,
  useInvalidatingMutation,
  useTemplate,
} from "../../hooks/queries";
import { useQuery } from "@tanstack/react-query";
import { ShadowPreview } from "./ShadowPreview";
import { AnalyticsEventsTab } from "./AnalyticsEventsTab";
import { entryLabel } from "../content-manager/format";

type Tab = "liquid" | "css" | "js" | "events";
const EMPTY_GA: Ga4Config = { itemMapping: {}, events: [] };

/** Route page — /templates/:typeUid (deep links, and the CTB tab's "open in a page" target) */
export function TemplateEditorPage() {
  const { typeUid } = useParams<{ typeUid: string }>();
  return <TemplateEditor typeUid={typeUid} mode="page" />;
}

export function TemplateEditor({
  typeUid,
  mode,
}: {
  typeUid?: string;
  /** page = own route (back button), embedded = inside the CTB Templates tab */
  mode: "page" | "embedded";
}) {
  const [fullscreen, setFullscreen] = useState(false);
  const { data: types } = useContentTypes();
  const contentType = types?.find((t) => t.uid === typeUid);
  const { data: tpl } = useTemplate(typeUid);
  const { data: entriesData } = useEntries(typeUid, { page: "1", pageSize: "20" });
  const { data: wsSettings } = useQuery({
    queryKey: ["workspace-settings"],
    queryFn: () => api<{ settings: { currency?: string } }>("/api/workspace-settings"),
  });

  const [tab, setTab] = useState<Tab>("liquid");
  const [liquid, setLiquid] = useState("");
  const [css, setCss] = useState("");
  const [js, setJs] = useState("");
  const [ga, setGa] = useState<Ga4Config>(EMPTY_GA);
  const [entryId, setEntryId] = useState("");
  const [preview, setPreview] = useState<{
    html: string;
    css: string;
    head?: string | null;
    checks?: AuditFinding[];
  } | null>(null);
  const [error, setError] = useState<string[] | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [clientAudit, setClientAudit] = useState<ShadowAuditResult>({ findings: [], checked: 0 });
  const shadowRootRef = useRef<ShadowRoot | null>(null);
  const onRendered = useCallback((root: ShadowRoot) => {
    shadowRootRef.current = root;
    setClientAudit(runShadowAudit(root));
  }, []);

  useEffect(() => {
    if (tpl && !loaded) {
      setLiquid(tpl.current?.liquid ?? "");
      setCss(tpl.current?.css ?? "");
      setJs(tpl.current?.js ?? "");
      const events = tpl.current?.events;
      setGa(events && "events" in events ? (events as Ga4Config) : EMPTY_GA);
      setLoaded(true);
    }
  }, [tpl, loaded]);

  // Esc exits fullscreen — same affordance as modals
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFullscreen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen]);

  const firstEntry = entriesData?.items[0]?.id;
  useEffect(() => {
    if (!entryId && firstEntry) setEntryId(firstEntry);
  }, [entryId, firstEntry]);

  // Live preview (600ms debounce)
  useEffect(() => {
    if (!entryId || !typeUid) return;
    const handle = setTimeout(() => {
      api<{ html: string; css: string; head?: string | null; checks?: AuditFinding[] }>(
        `/api/templates/${typeUid}/preview`,
        {
          method: "POST",
          body: { entryId, liquid, css },
        },
      )
        .then(setPreview)
        .catch((e) =>
          setPreview({
            html: `<pre style="color:red">${e instanceof Error ? e.message : "Render failed"}</pre>`,
            css: "",
          }),
        );
    }, 600);
    return () => clearTimeout(handle);
  }, [liquid, css, entryId, typeUid]);

  const save = useInvalidatingMutation(
    () =>
      api(`/api/templates/${typeUid}`, {
        method: "PUT",
        body: {
          liquid,
          css,
          // When locked, js is not sent → server keeps the previous version (enforced on both UI and API)
          ...(tpl?.canEditScript ? { js } : {}),
          events: ga,
        },
      }),
    [["template", typeUid!]],
  );

  const activate = useInvalidatingMutation(
    (version: number) =>
      api(`/api/templates/${typeUid}/versions/${version}/activate`, { method: "POST" }),
    [["template", typeUid!]],
  );


  if (!contentType) return null;

  const fileTabs: Array<{ key: Tab; label: string; locked?: boolean }> = [
    { key: "liquid", label: "template.liquid" },
    { key: "css", label: "style.css" },
    { key: "js", label: "script.js", locked: !tpl?.canEditScript },
    { key: "events", label: "analytics.json" },
  ];

  return (
    <div
      className={`tpl-shell${mode === "embedded" ? " embedded" : ""}${fullscreen ? " fullscreen" : ""}`}
    >
      <div className="tpl-head">
        {mode === "page" && (
          <Link to={`/ctb/${typeUid}`} className="btn tpl-back" title="Back to type">
            <svg width="1.4rem" height="1.4rem" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.7">
              <path d="M8.6 3.4 5 7l3.6 3.6" />
            </svg>
          </Link>
        )}
        <div style={{ minWidth: "0" }}>
          <div className="tpl-title">{contentType.name} · template bundle</div>
          <div className="tpl-sub">
            serving: JSON · ?format=html · ?format=head · embed.js
          </div>
        </div>
        <div style={{ flex: 1 }} />
        <span className="tpl-ver-chip">v{tpl?.current?.version ?? "—"}</span>
        {mode === "embedded" && (
          <button
            className="btn tpl-fs"
            title={fullscreen ? "Exit fullscreen (Esc)" : "Fullscreen"}
            onClick={() => setFullscreen((f) => !f)}
          >
            {fullscreen ? <IconArrowsMinimize size="1.5rem" /> : <IconArrowsMaximize size="1.5rem" />}
            {fullscreen ? "Exit fullscreen" : "Fullscreen"}
          </button>
        )}
        <button
          className="btn btn-primary"
          disabled={save.isPending}
          onClick={() =>
            save.mutate(undefined, {
              onSuccess: () => setError(null),
              onError: (e) => {
                const d = e instanceof ApiError ? (e.details as { issues?: string[] }) : null;
                setError(d?.issues ?? [e instanceof Error ? e.message : "Save failed"]);
              },
            })
          }
        >
          <IconDeviceFloppy size="1.5rem" /> Save version
        </button>
      </div>

      {error && (
        <div className="form-error" style={{ margin: "1.6rem" }}>
          <ul>{error.map((i) => <li key={i}>{i}</li>)}</ul>
        </div>
      )}

      <div className={tab === "events" ? "tpl-body no-preview" : "tpl-body"}>
        <div className="tpl-left">
          <div className="tpl-tabs">
            {fileTabs.map((f) => (
              <button
                key={f.key}
                className={tab === f.key ? "tpl-tab active" : "tpl-tab"}
                onClick={() => setTab(f.key)}
              >
                {f.locked && (
                  <svg width="1.1rem" height="1.1rem" viewBox="0 0 12 12" fill="none" stroke="var(--danger)" strokeWidth="1.7">
                    <rect x="2.4" y="5.2" width="7.2" height="5" rx="1.2" />
                    <path d="M4.2 5.2V4a1.8 1.8 0 0 1 3.6 0v1.2" />
                  </svg>
                )}
                {f.label}
              </button>
            ))}
          </div>

          {tab === "liquid" && (
            <div className="tpl-pane">
              <textarea className="code-area" value={liquid} onChange={(e) => setLiquid(e.target.value)}
                placeholder={`<h2>{{ values.title }}</h2>\n<p>{{ values.price | won }}</p>`} spellCheck={false} />
            </div>
          )}
          {tab === "css" && (
            <div className="tpl-pane">
              <textarea className="code-area" value={css} onChange={(e) => setCss(e.target.value)}
                placeholder={`.title { font-size: 1.5rem; }\n/* auto-scoped to .hub-${typeUid} when served */`} spellCheck={false} />
              <p className="widget-hint" style={{ marginTop: "1rem" }}>
                Mode ② (fragment) auto-scopes to <code>.hub-{typeUid}</code>,
                mode ③ (embed) is isolated by Shadow DOM.
              </p>
            </div>
          )}
          {tab === "js" &&
            (tpl?.canEditScript ? (
              <div className="tpl-pane">
                <textarea className="code-area" value={js} onChange={(e) => setJs(e.target.value)}
                  placeholder="// Runs in the customer's browser" spellCheck={false} />
              </div>
            ) : (
              <div className="tpl-locked">
                <div className="tpl-locked-card">
                  <span className="tpl-locked-icon">
                    <svg width="1.6rem" height="1.6rem" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
                      <rect x="3.4" y="7" width="9.2" height="6.2" rx="1.5" />
                      <path d="M5.6 7V5.4a2.4 2.4 0 0 1 4.8 0V7" />
                    </svg>
                  </span>
                  <h4>script.js · no permission</h4>
                  <p>
                    This file runs in the customer's browser, so editing it is separated from content roles to prevent XSS.
                    Your role can read it but not write — the save API rejects it the same way.
                  </p>
                  <div className="tpl-locked-role">required role: developer · granted by admin</div>
                  <pre className="code-area readonly" style={{ minHeight: "auto", maxHeight: "16rem" }}>
                    {js || "// (empty)"}
                  </pre>
                </div>
              </div>
            ))}
          {tab === "events" && (
            <div className="tpl-pane">
              <AnalyticsEventsTab
                config={ga}
                onChange={setGa}
                contentType={contentType}
                workspaceCurrency={wsSettings?.settings.currency}
              />
            </div>
          )}
        </div>

        {/* analytics.json edits nothing that the preview renders — give the editor the full width */}
        {tab !== "events" && (
        <div className="tpl-right">
          <div className="panel-row">
            <span className="panel-title">Live preview · Shadow DOM</span>
            <select value={entryId} onChange={(e) => setEntryId(e.target.value)} style={{ height: "3rem", fontSize: "1.2rem" }}>
              {(entriesData?.items ?? []).map((e) => (
                <option key={e.id} value={e.id}>
                  {entryLabel(contentType.definition, e.values, e.id)}
                </option>
              ))}
            </select>
          </div>
          {preview ? (
            <>
              <ShadowPreview html={preview.html} css={preview.css} onRendered={onRendered} />
              <AuditPanel
                findings={[...(preview.checks ?? []), ...clientAudit.findings] as ClientFinding[]}
                checkedCount={clientAudit.checked}
                onLocate={(f) => shadowRootRef.current && locateFinding(shadowRootRef.current, f)}
              />
            </>
          ) : (
            <p className="widget-hint">Pick an entry to see the rendered result.</p>
          )}
          <div className="panel-title" style={{ marginTop: "0.8rem" }}>Version</div>
          {(tpl?.versions ?? []).map((v) => (
            <div key={v.id} className="panel-row" style={{ fontSize: "1.2rem" }}>
              <span className="mono">v{v.version}{v.isCurrent && " · current"}</span>
              {!v.isCurrent && (
                <button className="link-btn" onClick={() => activate.mutate(v.version)}>
                  Make current
                </button>
              )}
            </div>
          ))}
        </div>
        )}
      </div>
    </div>
  );
}
