/**
 * API explorer (user request 2026-08-23) — a panel that documents the frontend-facing
 * Content Delivery endpoints as ready-to-run URIs: pick a type, get real sample URLs
 * (workspace slug + a published entry id filled in), send them, read the response.
 * Copy gives the same URI a customer frontend would call; /openapi.json holds the full spec.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { IconCopy, IconPlayerPlay, IconX } from "@tabler/icons-react";
import { api, getWorkspaceSlug } from "../../api/client";
import type { Entry, Paginated } from "../../api/types";
import { useContentTypes, useLocales } from "../../hooks/queries";

interface EndpointDef {
  label: string;
  hint: string;
  uri: string;
  /** type = scoped to the selected content type · workspace = site-wide surfaces */
  group: "type" | "workspace";
  /** list = the index screen's API, entry = the detail screen's APIs */
  scope?: "list" | "entry";
}

interface RunResult {
  uri: string;
  status: number;
  contentType: string;
  body: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The viewer is resized by hand often enough that reopening the panel should keep it */
const RESULT_HEIGHT_KEY = "prina.apiExplorer.resultHeight";
const RESULT_COPY_KEY = "__result";
/** Viewer truncation point — big enough for a full page of entries, small enough to render */
const VIEWER_CAP = 200_000;

/** The screen decides the defaults: /content/article/… → article + that entry */
function routeApiContext(pathname: string): { typeUid?: string; entryId?: string } {
  const seg = pathname.split("/").filter(Boolean);
  if ((seg[0] === "content" || seg[0] === "ctb" || seg[0] === "templates") && seg[1] && seg[1] !== "component") {
    const ctx: { typeUid?: string; entryId?: string } = { typeUid: seg[1] };
    if (seg[0] === "content" && seg[2] && UUID_RE.test(seg[2])) ctx.entryId = seg[2];
    return ctx;
  }
  return {};
}

export function ApiExplorerPanel({ open, onClose }: { open: boolean; onClose(): void }) {
  const { data: types } = useContentTypes();
  const { data: locales } = useLocales();
  const ws = getWorkspaceSlug();
  const location = useLocation();
  const route = routeApiContext(location.pathname);
  const [manualType, setManualType] = useState<string | null>(null);
  const [sampleId, setSampleId] = useState<string | null>(null);
  const [uris, setUris] = useState<Record<string, string>>({});
  const [result, setResult] = useState<RunResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"type" | "workspace">("type");
  const [copied, setCopied] = useState<string | null>(null);
  const resultRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);

  // Reopening the panel restores the height the separator was left at
  useEffect(() => {
    const el = resultRef.current;
    if (!el) return;
    const saved = localStorage.getItem(RESULT_HEIGHT_KEY);
    if (saved) el.style.height = saved;
  }, [open]);

  /** Separator drag: viewer height follows the pointer, clamped, persisted on release */
  const onResizeStart = (ev: React.PointerEvent) => {
    const el = resultRef.current;
    if (!el) return;
    ev.preventDefault();
    setDragging(true);
    const startY = ev.clientY;
    const startH = el.getBoundingClientRect().height;
    const move = (e: PointerEvent) => {
      const h = Math.min(Math.max(startH + (e.clientY - startY), 100), window.innerHeight * 0.7);
      el.style.height = `${h}px`;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDragging(false);
      if (el.style.height) localStorage.setItem(RESULT_HEIGHT_KEY, el.style.height);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // Navigating to another type's screen re-follows the screen (manual pick is per-visit)
  useEffect(() => {
    setManualType(null);
  }, [route.typeUid]);

  const effectiveTypeForReset = manualType ?? route.typeUid ?? types?.[0]?.uid ?? "";
  // Hand-edited URIs are per-context: a type/entry change must rebuild them, or rows the
  // user touched would stay frozen on the previous type ("no change" bug, 2026-08-23)
  useEffect(() => {
    setUris({});
    setResult(null);
  }, [effectiveTypeForReset, route.entryId]);

  const effectiveType = manualType ?? route.typeUid ?? types?.[0]?.uid ?? "";
  /** The entry being viewed wins over the published sample */
  const routeEntryId = route.typeUid === effectiveType ? route.entryId : undefined;

  // A real published entry makes the per-entry URIs runnable as-is
  useEffect(() => {
    if (!effectiveType) return;
    let alive = true;
    setSampleId(null);
    api<Paginated<Entry>>(`/api/content/${effectiveType}?status=published&pageSize=1`)
      .then((r) => { if (alive) setSampleId(r.items[0]?.id ?? null); })
      .catch(() => { if (alive) setSampleId(null); });
    return () => { alive = false; };
  }, [effectiveType]);

  const endpoints = useMemo<EndpointDef[]>(() => {
    const id = routeEntryId ?? sampleId ?? "{entryId}";
    const loc = locales?.find((l) => l.isDefault)?.code ?? locales?.[0]?.code ?? "en";
    // The filter example uses a real field of the type when one is filterable
    const filterable = types
      ?.find((t) => t.uid === effectiveType)
      ?.definition.fields.find((f) => ["text", "uid", "enum", "date", "number", "boolean"].includes(f.type));
    const filterExample = filterable
      ? `filters[${filterable.name}][$eq]=${filterable.type === "boolean" ? "true" : "{value}"}`
      : "filters[{field}][$eq]={value}";
    return [
      // ── type-scoped: list (each usage variant is its own runnable row) ──
      {
        label: "Entries · list",
        group: "type",
        scope: "list",
        hint: "All published entries of the type, newest first. Total count rides in the x-total-count response header.",
        uri: `/delivery/${effectiveType}?ws=${ws}`,
      },
      {
        label: "Entries · paginated",
        group: "type",
        scope: "list",
        hint: "page starts at 1; pageSize caps at 100. Page count = ceil(x-total-count / pageSize).",
        uri: `/delivery/${effectiveType}?ws=${ws}&page=1&pageSize=10`,
      },
      {
        label: "Entries · one locale",
        group: "type",
        scope: "list",
        hint: "Only entries in the given locale.",
        uri: `/delivery/${effectiveType}?ws=${ws}&locale=${loc}`,
      },
      {
        label: "Entries · populated",
        group: "type",
        scope: "list",
        hint: "populate=1 resolves relation/media ids into inline objects (published targets only).",
        uri: `/delivery/${effectiveType}?ws=${ws}&populate=1&page=1&pageSize=10`,
      },
      {
        label: "Entries · filtered",
        group: "type",
        scope: "list",
        hint: "filters[field][$op]=value, ANDed. Ops: $eq $ne $in $notIn $contains $lt $lte $gt $gte $null ($in takes comma lists; relation $eq matches has-many membership).",
        uri: `/delivery/${effectiveType}?ws=${ws}&${filterExample}`,
      },
      // ── type-scoped: one entry ──
      {
        label: "Entry · JSON",
        group: "type",
        scope: "entry",
        hint: "Published entry values (+seo payload). Relations/media come as ids.",
        uri: `/delivery/${effectiveType}/${id}?ws=${ws}`,
      },
      {
        label: "Entry · JSON populated",
        group: "type",
        scope: "entry",
        hint: "Same entry with relation/media ids resolved into inline objects.",
        uri: `/delivery/${effectiveType}/${id}?ws=${ws}&populate=1`,
      },
      {
        label: "Entry · SSR head",
        group: "type",
        scope: "entry",
        hint: "format=head — title/OG/canonical/JSON-LD snippet to render into your <head>.",
        uri: `/delivery/${effectiveType}/${id}?format=head&ws=${ws}`,
      },
      {
        label: "Entry · JSON-LD",
        group: "type",
        scope: "entry",
        hint: "format=jsonld — schema.org structured data only.",
        uri: `/delivery/${effectiveType}/${id}?format=jsonld&ws=${ws}`,
      },
      {
        label: "Entry · rendered HTML",
        group: "type",
        scope: "entry",
        hint: "format=html — the type's Liquid template rendered server-side, ready for your <body>.",
        uri: `/delivery/${effectiveType}/${id}?format=html&ws=${ws}`,
      },
      {
        label: "Entry · embed payload",
        group: "type",
        scope: "entry",
        hint: "embed=1 — {html,css,js} JSON consumed by embed.js (Shadow DOM widget).",
        uri: `/delivery/${effectiveType}/${id}?format=html&embed=1&ws=${ws}`,
      },
      // ── workspace-wide surfaces ──
      {
        label: "Search",
        group: "workspace",
        hint: "Published-content search (FTS; semantic fused when embeddings are on).",
        uri: `/delivery/search?q=hello&ws=${ws}`,
      },
      {
        label: "Search · filtered",
        group: "workspace",
        hint: "type= and locale= narrow the scope; limit caps at 50 (default 20).",
        uri: `/delivery/search?q=hello&type=${effectiveType}&locale=${loc}&limit=10&ws=${ws}`,
      },
      {
        label: "sitemap.xml",
        group: "workspace",
        hint: "Locale-alternate sitemap of SEO-enabled types.",
        uri: `/delivery/sitemap.xml?ws=${ws}`,
      },
      {
        label: "robots.txt",
        group: "workspace",
        hint: "Points crawlers at the sitemap.",
        uri: `/delivery/robots.txt?ws=${ws}`,
      },
      {
        label: "llms.txt",
        group: "workspace",
        hint: "Content survey for AI agents (GEO).",
        uri: `/delivery/llms.txt?ws=${ws}`,
      },
      {
        label: "embed.js",
        group: "workspace",
        hint: "Widget script: <script src=\"…/delivery/embed.js\"> + <div data-prina-embed=\"{entry URL}\">.",
        uri: `/delivery/embed.js`,
      },
      {
        label: "Asset file",
        group: "workspace",
        hint: "The binary behind any media field id (redirects to storage on S3). Swap in an id from an entry response.",
        uri: `/delivery/assets/{assetId}`,
      },
    ];
  }, [effectiveType, sampleId, routeEntryId, ws, locales, types]);

  const uriOf = (e: EndpointDef) => uris[e.label] ?? e.uri;

  const run = async (e: EndpointDef) => {
    setBusy(true);
    setResult(null);
    const uri = uriOf(e);
    try {
      const res = await fetch(uri, { credentials: "same-origin" });
      const contentType = res.headers.get("content-type") ?? "";
      const raw = await res.text();
      let body = raw;
      if (contentType.includes("json")) {
        try { body = JSON.stringify(JSON.parse(raw), null, 2); } catch { /* keep raw */ }
      }
      setResult({
        uri,
        status: res.status,
        contentType,
        // A list response with rich bodies runs to hundreds of KB — 6k cut a single
        // entry in half and read as "the API returned less than it did" (2026-08-24)
        body:
          body.length > VIEWER_CAP
            ? `${body.slice(0, VIEWER_CAP)}\n… response is ${body.length.toLocaleString()} chars — showing the first ${VIEWER_CAP.toLocaleString()}. Narrow with page/pageSize, or open the URI in a browser tab.`
            : body,
      });
    } catch {
      setResult({ uri, status: 0, contentType: "", body: "Request failed" });
    } finally {
      setBusy(false);
    }
  };

  const copyUri = (key: string, uri: string) => {
    void navigator.clipboard.writeText(`${window.location.origin}${uri}`);
    setCopied(key);
    setTimeout(() => setCopied(null), 1500);
  };

  const copy = (e: EndpointDef) => copyUri(e.label, uriOf(e));

  if (!open) return null;
  return (
    <aside className="assistant-panel api-panel">
      <div className="assistant-head">
        <strong>Content Delivery API</strong>
        <a className="muted" href="/openapi.json" target="_blank" rel="noreferrer">openapi.json ↗</a>
        <button className="btn btn-ghost btn-sm" onClick={onClose} style={{ marginLeft: "auto" }}>
          <IconX size="1.5rem" />
        </button>
      </div>
      <div className="assistant-msgs">
        <div className="api-result" ref={resultRef}>
          {result ? (
            <>
              <div className="api-endpoint-head">
                <strong>{result.status || "ERR"}</strong>
                <code>{result.uri}</code>
                <button className="api-result-copy" title="Copy full URL"
                  onClick={() => copyUri(RESULT_COPY_KEY, result.uri)}>
                  {copied === RESULT_COPY_KEY ? "✓" : <IconCopy size="1.3rem" />}
                </button>
              </div>
              <pre>{result.body}</pre>
            </>
          ) : (
            <pre className="muted">Run an endpoint ▶</pre>
          )}
        </div>
        <div
          className={dragging ? "api-resizer dragging" : "api-resizer"}
          title="Drag to resize"
          onPointerDown={onResizeStart}
        />
        <div className="tabs api-tabs">
          {([["type", "Content type"], ["workspace", "Workspace"]] as const).map(([key, label]) => (
            <button key={key} className={tab === key ? "tab active" : "tab"} onClick={() => setTab(key)}>
              {label}
            </button>
          ))}
        </div>
        {tab === "type" && (
          <label className="field">
            <span>
              Content type
              {route.typeUid && !manualType && <span className="muted"> — following this screen</span>}
            </span>
            <select value={effectiveType} onChange={(e) => setManualType(e.target.value)}>
              {(types ?? []).map((t) => <option key={t.uid} value={t.uid}>{t.name}</option>)}
            </select></label>
        )}
        {endpoints
          .filter((e) => e.group === tab)
          // The screen decides which type-scoped APIs matter: a CM list shows the list API,
          // an entry shows the entry APIs; elsewhere (CTB etc.) both are useful
          .filter((e) => {
            if (tab !== "type" || !location.pathname.startsWith("/content/") || !route.typeUid) return true;
            return route.entryId ? e.scope === "entry" : e.scope === "list";
          })
          .map((e) => (
          <div key={e.label} className="api-endpoint">
            <div className="api-endpoint-head">
              <strong>{e.label}</strong>
              <span className="api-method">GET</span>
            </div>
            <div className="muted api-hint">{e.hint}</div>
            <div className="api-endpoint-row">
              <span className="api-uri-wrap">
                <input value={uriOf(e)}
                  onChange={(ev) => setUris((p) => ({ ...p, [e.label]: ev.target.value }))} />
                <button className="api-copy" title="Copy full URL" onClick={() => copy(e)}>
                  {copied === e.label ? "✓" : <IconCopy size="1.3rem" />}
                </button>
              </span>
              <button className="btn btn-sm" title="Run" disabled={busy} onClick={() => void run(e)}>
                <IconPlayerPlay size="1.3rem" />
              </button>
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}
