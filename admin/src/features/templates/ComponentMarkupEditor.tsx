/**
 * Component markup editor (40-IMPL) — the partial named by the component uid: partial.liquid,
 * style.css, script.js (template_script lock) with versions, and a live preview rendered from a
 * sample block value the developer can edit. Same shell grammar as the type template editor
 * (tpl-shell embedded), minus the entry picker and analytics — a component has no entries.
 */
import { useEffect, useState } from "react";
import { IconChevronDown, IconDeviceFloppy } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../../api/client";
import { FieldType, type ComponentDef, type FieldDef, type PartialGetResult } from "../../api/types";
import { useInvalidatingMutation } from "../../hooks/queries";
import { ShadowPreview } from "./ShadowPreview";

type Tab = "liquid" | "css" | "js";

/** A sample block value derived from the field definitions — what `blk` holds in the preview */
export function sampleBlockValue(fields: FieldDef[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const label = f.label ?? f.name;
    switch (f.type) {
      case FieldType.Text:
      case FieldType.Uid:
        out[f.name] = f.name.startsWith("opt_") ? label : `${label} sample`;
        break;
      case FieldType.Richtext:
        out[f.name] = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: `${label} paragraph.` }] }] };
        break;
      case FieldType.Number:
        out[f.name] = 1;
        break;
      case FieldType.Boolean:
        out[f.name] = true;
        break;
      case FieldType.Date:
        out[f.name] = new Date().toISOString().slice(0, 10);
        break;
      case FieldType.Enum: {
        const opts = (f.options as string[] | undefined) ?? [];
        out[f.name] = opts[0] ?? "";
        break;
      }
      case FieldType.Json:
        out[f.name] = {};
        break;
      case FieldType.DynamicZone:
        out[f.name] = [];
        break;
      default:
        // media · relation · component — no fixture value; the partial should guard with {% if %}
        out[f.name] = null;
    }
  }
  return out;
}

export function ComponentMarkupEditor({ component }: { component: ComponentDef }) {
  const name = component.uid;
  const qc = useQueryClient();
  const { data: tpl, isLoading } = useQuery({
    queryKey: ["partial", name],
    queryFn: () =>
      api<PartialGetResult>(`/api/templates/partials/${name}`).catch((e) => {
        if (e instanceof ApiError && e.status === 404) return { current: null, versions: [], canEditScript: true } as PartialGetResult;
        throw e;
      }),
  });
  const canEditScript = tpl?.canEditScript ?? true;

  const [tab, setTab] = useState<Tab>("liquid");
  const [liquid, setLiquid] = useState("");
  const [css, setCss] = useState("");
  const [js, setJs] = useState("");
  const [sample, setSample] = useState(() => JSON.stringify(sampleBlockValue(component.definition.fields), null, 2));
  const [sampleError, setSampleError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [preview, setPreview] = useState<{ html: string; css: string } | null>(null);
  const [error, setError] = useState<string[] | null>(null);

  useEffect(() => {
    if (tpl && !loaded) {
      setLiquid(tpl.current?.liquid ?? defaultSource(component));
      setCss(tpl.current?.css ?? "");
      setJs(tpl.current?.js ?? "");
      setLoaded(true);
    }
  }, [tpl, loaded, component]);

  useEffect(() => {
    if (!versionsOpen) return;
    const close = (e: MouseEvent) => {
      if (!(e.target as Element | null)?.closest?.("[data-pop='partial-versions']")) setVersionsOpen(false);
    };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setVersionsOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", key); };
  }, [versionsOpen]);

  // Live preview (600ms debounce) — unsaved liquid/css with the sample value as `blk`
  useEffect(() => {
    if (!loaded) return;
    let values: Record<string, unknown>;
    try {
      values = JSON.parse(sample) as Record<string, unknown>;
      setSampleError(null);
    } catch (e) {
      setSampleError(e instanceof Error ? e.message : "Invalid JSON");
      return;
    }
    const handle = setTimeout(() => {
      api<{ html: string; css: string }>(`/api/templates/partials/${name}/render`, {
        method: "POST",
        body: { values, liquid, css },
      })
        .then(setPreview)
        .catch((e) =>
          setPreview({ html: `<pre style="color:red">${e instanceof Error ? e.message : "Render failed"}</pre>`, css: "" }),
        );
    }, 600);
    return () => clearTimeout(handle);
  }, [liquid, css, sample, name, loaded]);

  const save = useInvalidatingMutation(
    () =>
      api(`/api/templates/partials/${name}`, {
        method: "PUT",
        // When locked, js is not sent → server keeps the previous version (enforced on both sides)
        body: { liquid, css, ...(canEditScript ? { js } : {}) },
      }),
    [["partial", name], ["components"]],
  );
  const activate = useInvalidatingMutation(
    (version: number) => api(`/api/templates/partials/${name}/versions/${version}/activate`, { method: "POST" }),
    [["partial", name], ["components"]],
  );
  // activate changes the sources — reload them from the new current
  useEffect(() => {
    if (activate.isSuccess) {
      setLoaded(false);
      void qc.invalidateQueries({ queryKey: ["partial", name] });
    }
  }, [activate.isSuccess, qc, name]);

  if (isLoading) return null;

  const fileTabs: Array<{ key: Tab; label: string; locked?: boolean }> = [
    { key: "liquid", label: "partial.liquid" },
    { key: "css", label: "style.css" },
    { key: "js", label: "script.js", locked: !canEditScript },
  ];

  return (
    <div className="tpl-shell embedded">
      <div className="tpl-head">
        <div style={{ minWidth: 0 }}>
          <div className="tpl-title">{component.name} · markup bundle</div>
          <div className="tpl-sub">{`{% render '${name}' with blk as blk %}`} · style.css · script.js</div>
        </div>
        <div style={{ flex: 1 }} />
        <div className="tpl-save" data-pop="partial-versions">
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
              <div className="popover-label">Versions · current is rendered</div>
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

      <div className="tpl-body">
        <div className="tpl-left" style={{ flex: "0 0 calc(55% - 0.5rem)" }}>
          <div className="tpl-tabs">
            {fileTabs.map((f) => (
              <button key={f.key} className={tab === f.key ? "tpl-tab active" : "tpl-tab"} onClick={() => setTab(f.key)}>
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
              <textarea className="code-area" value={liquid} onChange={(e) => setLiquid(e.target.value)} spellCheck={false}
                placeholder={`<section class="${cssClass(name)}">\n  <h2>{{ blk.title | escape }}</h2>\n</section>`} />
              <p className="widget-hint" style={{ marginTop: "1rem" }}>
                The block value is <code>blk</code>. A page template renders this with{" "}
                <code>{`{% render blk.__component with blk as blk %}`}</code>.
              </p>
            </div>
          )}
          {tab === "css" && (
            <div className="tpl-pane">
              <textarea className="code-area" value={css} onChange={(e) => setCss(e.target.value)} spellCheck={false}
                placeholder={`.${cssClass(name)} { display: grid; gap: 1rem; }`} />
              <p className="widget-hint" style={{ marginTop: "1rem" }}>
                Served version-pinned as <code>style.css</code> and linked by every page that renders this component.
                Scope selectors under the component root.
              </p>
            </div>
          )}
          {tab === "js" &&
            (canEditScript ? (
              <div className="tpl-pane">
                <textarea className="code-area" value={js} onChange={(e) => setJs(e.target.value)} spellCheck={false}
                  placeholder="// Runs once per page that renders this component" />
              </div>
            ) : (
              <div className="tpl-locked">
                <div className="tpl-locked-card">
                  <h4>script.js · no permission</h4>
                  <p>This file runs in the customer's browser, so editing it is separated from content roles. Your role can read it but not write.</p>
                  <pre className="code-area readonly" style={{ minHeight: "auto", maxHeight: "16rem" }}>{js || "// (empty)"}</pre>
                </div>
              </div>
            ))}
        </div>

        <div className="tpl-right">
          <div className="panel-row tpl-preview-head">
            <span className="panel-title">Live preview · Shadow DOM</span>
          </div>
          {preview ? <ShadowPreview html={preview.html} css={preview.css} /> : <p className="widget-hint">Rendering…</p>}
          <div className="panel-row tpl-preview-head" style={{ marginTop: "1.2rem" }}>
            <span className="panel-title">Sample value · blk</span>
            {sampleError && <span className="widget-hint" style={{ color: "var(--danger)" }}>{sampleError}</span>}
            <div style={{ flex: 1 }} />
            <button className="btn btn-ghost" style={{ height: "2.8rem", fontSize: "1.2rem" }}
              onClick={() => setSample(JSON.stringify(sampleBlockValue(component.definition.fields), null, 2))}>
              Reset from fields
            </button>
          </div>
          <textarea className="code-area" style={{ minHeight: "14rem" }} value={sample} onChange={(e) => setSample(e.target.value)} spellCheck={false} />
        </div>
      </div>
    </div>
  );
}

/** `ds.card` → `ds-card`: the uid already carries its namespace, so no extra prefix */
const cssClass = (uid: string) => uid.replace(/[^a-z0-9]+/g, "-");

/** First source for a component that has no markup yet — one element per field, escaped */
function defaultSource(component: ComponentDef): string {
  const lines = component.definition.fields
    .filter((f) => f.type === FieldType.Text || f.type === FieldType.Uid || f.type === FieldType.Number || f.type === FieldType.Enum)
    .map((f) => `  <p class="${cssClass(component.uid)}__${f.name}">{{ blk.${f.name} | escape }}</p>`);
  return `<section class="${cssClass(component.uid)}" data-component="${component.uid}">\n${lines.join("\n")}\n</section>\n`;
}
