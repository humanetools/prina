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
  IconChevronDown,
  IconLayoutColumns,
  IconLayoutRows,
  IconListCheck,
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
  // key: route param changes reuse the element — remount so no per-type state survives a type switch
  return <TemplateEditor key={typeUid} typeUid={typeUid} mode="page" />;
}

type PaneLayout = "side" | "stack";
const LAYOUT_KEY = "prina.tpl.layout";
const SPLIT_KEY = "prina.tpl.split";
const DEFAULT_SPLIT: Record<PaneLayout, number> = { side: 0.6, stack: 0.55 };
const clampSplit = (r: number) => Math.min(0.8, Math.max(0.25, r));
function readLayout(): PaneLayout {
  try { return localStorage.getItem(LAYOUT_KEY) === "stack" ? "stack" : "side"; } catch { return "side"; }
}
function readSplit(layout: PaneLayout): number {
  try {
    const v = Number(localStorage.getItem(`${SPLIT_KEY}.${layout}`));
    return Number.isFinite(v) && v > 0 ? clampSplit(v) : DEFAULT_SPLIT[layout];
  } catch { return DEFAULT_SPLIT[layout]; }
}

export function TemplateEditor({
  typeUid,
  mode,
  hidePreview = false,
}: {
  typeUid?: string;
  /** page = own route (back button), embedded = inside the CTB Templates tab */
  mode: "page" | "embedded";
  /** Flow Web › Elements popup: editor only — the right pane (live preview, checks, versions) is hidden */
  hidePreview?: boolean;
}) {
  const [fullscreen, setFullscreen] = useState(false);
  // Code ↔ preview arrangement: side-by-side or stacked, plus a draggable split (both remembered)
  const [layout, setLayout] = useState<PaneLayout>(() => readLayout());
  const [split, setSplit] = useState<number>(() => readSplit(readLayout()));
  const splitRef = useRef<HTMLDivElement>(null);
  const splitDrag = useRef(false);
  useEffect(() => {
    try { localStorage.setItem(LAYOUT_KEY, layout); } catch { /* private mode */ }
    setSplit(readSplit(layout));
  }, [layout]);
  useEffect(() => {
    try { localStorage.setItem(`${SPLIT_KEY}.${layout}`, String(split)); } catch { /* private mode */ }
  }, [split, layout]);
  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (!splitDrag.current || !splitRef.current) return;
      const rect = splitRef.current.getBoundingClientRect();
      const ratio = layout === "stack"
        ? (e.clientY - rect.top) / rect.height
        : (e.clientX - rect.left) / rect.width;
      setSplit(clampSplit(ratio));
    };
    const up = () => { splitDrag.current = false; document.body.style.cursor = ""; };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [layout]);
  const { data: types } = useContentTypes();
  const contentType = types?.find((t) => t.uid === typeUid);
  const { data: tpl } = useTemplate(typeUid);
  // isPlaceholderData: useEntries keeps the previous type's list while the new one loads — never seed from it
  const { data: entriesData, isPlaceholderData: entriesStale } = useEntries(typeUid, { page: "1", pageSize: "20" });
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
  /** mirrors delivery `?populate=1` — relations/media inline in the Liquid scope */
  const [populate, setPopulate] = useState(false);
  // Preview chrome: checks panel is opt-in behind a button; versions live in the Save split button
  const [checksOpen, setChecksOpen] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);
  useEffect(() => {
    if (!versionsOpen) return;
    const close = (e: MouseEvent) => {
      if (!(e.target as Element | null)?.closest?.("[data-pop='tpl-versions']")) setVersionsOpen(false);
    };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setVersionsOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", key); };
  }, [versionsOpen]);
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

  // Switching types forgets the previous type's entry — otherwise type B's preview is asked for
  // type A's entry id ("Entry … not found", hand-off-01 §1)
  useEffect(() => {
    setEntryId("");
  }, [typeUid]);
  const firstEntry = entriesStale ? undefined : entriesData?.items[0]?.id;
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
          body: { entryId, liquid, css, populate },
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
  }, [liquid, css, entryId, typeUid, populate]);

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
        {!hidePreview && (
          <div className="seg tpl-layout" role="group" aria-label="Editor layout">
            <button
              className={layout === "side" ? "active" : ""}
              title="Code and preview side by side"
              aria-pressed={layout === "side"}
              onClick={() => setLayout("side")}
            >
              <IconLayoutColumns size="1.5rem" />
            </button>
            <button
              className={layout === "stack" ? "active" : ""}
              title="Code above, preview below"
              aria-pressed={layout === "stack"}
              onClick={() => setLayout("stack")}
            >
              <IconLayoutRows size="1.5rem" />
            </button>
          </div>
        )}
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
        <div className="tpl-save" data-pop="tpl-versions">
          <button
            className="btn btn-primary tpl-save-main"
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
          <button
            className="btn btn-primary tpl-save-ver"
            title="Versions — pick one to make it current"
            aria-haspopup="menu"
            aria-expanded={versionsOpen}
            onClick={() => setVersionsOpen((o) => !o)}
          >
            v{tpl?.current?.version ?? "—"} <IconChevronDown size="1.3rem" />
          </button>
          {versionsOpen && (
            <div className="popover tpl-versions" role="menu">
              <div className="popover-label">Versions · current is served</div>
              {(tpl?.versions ?? []).length === 0 && <div className="widget-hint" style={{ padding: "0.8rem 1rem" }}>No saved version yet.</div>}
              {(tpl?.versions ?? []).map((v) => (
                <button
                  key={v.id}
                  role="menuitem"
                  className={`popover-item${v.isCurrent ? " active" : ""}`}
                  disabled={v.isCurrent || activate.isPending}
                  onClick={() => activate.mutate(v.version, { onSuccess: () => setVersionsOpen(false) })}
                >
                  <span className="mono">v{v.version}</span>
                  <span className="widget-hint">{v.isCurrent ? "current" : "Make current"}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {error && (
        <div className="form-error" style={{ margin: "1.6rem" }}>
          <ul>{error.map((i) => <li key={i}>{i}</li>)}</ul>
        </div>
      )}

      {(() => { const showPreview = tab !== "events" && !hidePreview; return (
      <div
        ref={splitRef}
        className={`tpl-body${showPreview ? "" : " no-preview"}${layout === "stack" ? " stack" : ""}`}
      >
        <div className="tpl-left" style={showPreview ? { flex: `0 0 calc(${(split * 100).toFixed(2)}% - 0.5rem)` } : undefined}>
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
        {showPreview && (
          <div
            className="tpl-divider"
            role="separator"
            aria-orientation={layout === "stack" ? "horizontal" : "vertical"}
            aria-valuenow={Math.round(split * 100)}
            tabIndex={0}
            title="Drag to resize · arrow keys to nudge"
            onPointerDown={(e) => { e.preventDefault(); splitDrag.current = true; document.body.style.cursor = layout === "stack" ? "row-resize" : "col-resize"; }}
            onKeyDown={(e) => {
              const dec = layout === "stack" ? "ArrowUp" : "ArrowLeft";
              const inc = layout === "stack" ? "ArrowDown" : "ArrowRight";
              if (e.key === dec) setSplit((v) => clampSplit(v - 0.02));
              if (e.key === inc) setSplit((v) => clampSplit(v + 0.02));
            }}
          >
            <span className="tpl-divider-grip" />
          </div>
        )}
        {showPreview && (
        <div className="tpl-right">
          <div className="panel-row tpl-preview-head">
            <span className="panel-title">Live preview · Shadow DOM</span>
            <select value={entryId} onChange={(e) => setEntryId(e.target.value)} style={{ height: "3rem", fontSize: "1.2rem" }}>
              {(entriesData?.items ?? []).map((e) => (
                <option key={e.id} value={e.id}>
                  {entryLabel(contentType.definition, e.values, e.id)}
                </option>
              ))}
            </select>
            <label
              title="Render as delivery ?populate=1 — relations/media become objects (values.rel.values.*)"
              style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem", fontSize: "1.2rem", marginLeft: "0.8rem" }}
            >
              <input type="checkbox" checked={populate} onChange={(e) => setPopulate(e.target.checked)} />
              populate
            </label>
            <div style={{ flex: 1 }} />
            {preview && (() => {
              const all = [...(preview.checks ?? []), ...clientAudit.findings];
              const errors = all.filter((f) => f.severity === "error").length;
              const warns = all.filter((f) => f.severity === "warn").length;
              const tone = errors ? "danger" : warns ? "warn" : "ok";
              return (
                <button
                  className={`btn tpl-checks${checksOpen ? " active" : ""}`}
                  title="SEO & accessibility checks on the rendered preview"
                  aria-pressed={checksOpen}
                  onClick={() => setChecksOpen((o) => !o)}
                >
                  <IconListCheck size="1.4rem" /> Checks
                  <span className={`tpl-checks-badge ${tone}`}>{all.length === 0 ? "✓" : all.length}</span>
                </button>
              );
            })()}
          </div>
          {preview ? (
            <>
              <ShadowPreview html={preview.html} css={preview.css} onRendered={onRendered} />
              {checksOpen && (
                <AuditPanel
                  headless
                  findings={[...(preview.checks ?? []), ...clientAudit.findings] as ClientFinding[]}
                  checkedCount={clientAudit.checked}
                  onLocate={(f) => shadowRootRef.current && locateFinding(shadowRootRef.current, f)}
                />
              )}
            </>
          ) : (
            <p className="widget-hint">Pick an entry to see the rendered result.</p>
          )}
        </div>
        )}
      </div>
      ); })()}
    </div>
  );
}
