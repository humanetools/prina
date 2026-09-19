/**
 * Settings › AI (11-IMPL provider routing) — two tabs (Language model / Semantic search),
 * each an ordered failover CHAIN of providers rather than a single connection:
 * routing-order card (rows with live health, per-row menu, failover knobs, "Test the order"),
 * provider catalog with a connect modal, and the routing log.
 * Design source: Claude Design "Prina CMS - AI.dc.html" (user, 2026-09-04) — px→rem (÷10).
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, apiErrorMessage } from "../../api/client";

type Target = "lm" | "ss";

interface ChainEntryView {
  id: string;
  provider: string;
  name: string | null;
  label: string;
  model: string;
  baseUrl: string | null;
  apiKeyMasked: string | null;
  workspaceIdSet: boolean;
  health: "ok" | "down";
  downSince: number | null;
}
interface ChainView {
  failover: boolean;
  retries: number;
  timeoutSec: number;
  chain: ChainEntryView[];
}
interface AiStatus {
  routing: { lm: ChainView; ss: ChainView; log: Array<{ t: number; kind: "ok" | "warn" | "muted"; text: string }> };
}

interface CatalogMeta {
  name: string;
  mono: string;
  tint: string;
  tintBg: string;
  sub: string;
  docs?: string;
  keyHint: string;
  models: string[];
  modelHint?: string;
}
const CUSTOM_META: CatalogMeta = {
  name: "Custom endpoint", mono: "⌁", tint: "var(--text-2)", tintBg: "var(--surface-3)",
  sub: "Any endpoint that speaks the OpenAI API.", keyHint: "optional", models: [],
};
const CATALOG: Record<Target, Record<string, CatalogMeta>> = {
  lm: {
    anthropic: { name: "Anthropic", mono: "A", tint: "var(--accent-on)", tintBg: "var(--accent)", sub: "Claude Sonnet 5, Opus 5", docs: "https://console.anthropic.com/settings/keys", keyHint: "sk-ant-…", models: ["claude-sonnet-5", "claude-opus-5", "claude-haiku-4-5"] },
    openai: { name: "OpenAI", mono: "O", tint: "var(--accent-on)", tintBg: "var(--accent)", sub: "GPT-5.1, GPT-5 mini", docs: "https://platform.openai.com/api-keys", keyHint: "sk-proj-…", models: ["gpt-5.1", "gpt-5-mini", "gpt-5"] },
    gemini: { name: "Google Gemini", mono: "G", tint: "var(--accent-on)", tintBg: "var(--accent)", sub: "Gemini 2.5 Pro, Flash", docs: "https://aistudio.google.com/apikey", keyHint: "AIza…", models: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-3-pro-preview"] },
    mistral: { name: "Mistral", mono: "M", tint: "var(--accent-on)", tintBg: "var(--accent)", sub: "Large, Small", docs: "https://console.mistral.ai/api-keys", keyHint: "…", models: ["mistral-large-latest", "mistral-small-latest"] },
    xai: { name: "xAI", mono: "X", tint: "var(--accent-on)", tintBg: "var(--accent)", sub: "Grok 4, Grok 4 mini", docs: "https://console.x.ai", keyHint: "xai-…", models: ["grok-4", "grok-4-mini"] },
    llama: { name: "Meta Llama", mono: "L", tint: "var(--accent-on)", tintBg: "var(--accent)", sub: "Llama 4 Maverick, Scout", docs: "https://llama.developer.meta.com", keyHint: "LLM|…", models: ["Llama-4-Maverick-17B-128E-Instruct-FP8", "Llama-4-Scout-17B-16E-Instruct-FP8"] },
    custom: { ...CUSTOM_META, modelHint: "llama-3.3-70b-instruct" },
  },
  ss: {
    voyage: { name: "Voyage AI", mono: "V", tint: "var(--accent-on)", tintBg: "var(--accent)", sub: "voyage-3.5, voyage-3-large", docs: "https://dashboard.voyageai.com/organization/api-keys", keyHint: "pa-…", models: ["voyage-3.5-lite", "voyage-3.5", "voyage-3-large"] },
    openai: { name: "OpenAI", mono: "O", tint: "var(--accent-on)", tintBg: "var(--accent)", sub: "text-embedding-3 family", docs: "https://platform.openai.com/api-keys", keyHint: "sk-proj-…", models: ["text-embedding-3-small", "text-embedding-3-large"] },
    custom: { ...CUSTOM_META, sub: "Any endpoint that speaks the OpenAI embeddings API.", modelHint: "bge-m3" },
  },
};
const meta = (target: Target, provider: string): CatalogMeta =>
  CATALOG[target][provider] ?? { ...CUSTOM_META, name: provider };

const fmtTime = (t: number) =>
  new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

export function AiPage() {
  const qc = useQueryClient();
  const { data } = useQuery<AiStatus>({ queryKey: ["ai-settings"], queryFn: () => api("/api/ai/settings") });
  const [tab, setTab] = useState<Target>("lm");
  const [menuId, setMenuId] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [fKey, setFKey] = useState("");
  const [fModel, setFModel] = useState("");
  const [fName, setFName] = useState("");
  const [fUrl, setFUrl] = useState("");
  const [fWsId, setFWsId] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  const view = data?.routing[tab];
  const log = data?.routing.log ?? [];

  const put = async (body: Record<string, unknown>, done?: string) => {
    try {
      await api("/api/ai/settings", { method: "PUT", body });
      await qc.invalidateQueries({ queryKey: ["ai-settings"] });
      setMsg(done ?? null);
    } catch (e) {
      setMsg(apiErrorMessage(e, "Save failed"));
    }
  };
  /** Round-trip the chain without keys — the server keeps stored keys by id */
  const chainBody = (entries: ChainEntryView[]) =>
    entries.map((e) => ({
      id: e.id, provider: e.provider, model: e.model,
      ...(e.name ? { name: e.name } : {}),
      ...(e.baseUrl ? { baseUrl: e.baseUrl } : {}),
    }));
  const saveChain = (entries: ChainEntryView[], done?: string) =>
    put({ [tab]: { chain: chainBody(entries) } }, done);

  const runTest = async () => {
    if (!view || testing) return;
    setTesting(true);
    try {
      const out = await api<{ results: Array<{ label: string; ok: boolean; ms: number; error: string | null }> }>(
        "/api/ai/test", { method: "POST", body: { target: tab } },
      );
      const first = out.results.find((r) => r.ok);
      setMsg(first
        ? `Test — ${first.label} responded in ${(first.ms / 1000).toFixed(1)} s`
        : `Test — every provider failed${out.results[0]?.error ? ` (${out.results[0].error})` : ""}`);
      await qc.invalidateQueries({ queryKey: ["ai-settings"] });
    } catch (e) {
      setMsg(apiErrorMessage(e, "Test failed"));
    } finally {
      setTesting(false);
    }
  };

  const openAdd = (provider: string) => {
    const m = meta(tab, provider);
    setAdding(provider); setFKey(""); setFModel(m.models[0] ?? ""); setFName(""); setFUrl(""); setFWsId("");
    setMenuId(null); setMsg(null);
  };
  const confirmAdd = async () => {
    if (!adding || !view) return;
    const entry: Record<string, unknown> = {
      provider: adding,
      ...(fKey ? { apiKey: fKey } : {}),
      ...(fModel ? { model: fModel } : {}),
      ...(adding === "custom" ? { name: fName || "Custom endpoint", baseUrl: fUrl } : {}),
      ...(adding === "anthropic" && fWsId ? { anthropicWorkspaceId: fWsId } : {}),
    };
    await put(
      { [tab]: { chain: [...chainBody(view.chain), entry] } },
      `${meta(tab, adding).name} connected at position ${view.chain.length + 1}`,
    );
    setAdding(null);
  };

  if (!data || !view) return <p className="muted">Loading…</p>;

  const activeId = (view.failover ? view.chain.find((e) => e.health === "ok" && e.apiKeyMasked) : view.chain[0])?.id ?? null;
  const move = (i: number, to: number) => {
    if (to < 0 || to >= view.chain.length) return;
    const arr = [...view.chain];
    const [row] = arr.splice(i, 1);
    arr.splice(to, 0, row!);
    setMenuId(null);
    void saveChain(arr, `${row!.label} moved to position ${to + 1}`);
  };

  const addMeta = adding ? meta(tab, adding) : null;

  return (
    <>
      <div className="page-head"><h1>AI</h1></div>

      <div className="tabs">
        {([["lm", "Language model"], ["ss", "Semantic search"]] as const).map(([key, label]) => (
          <button key={key} className={tab === key ? "tab active" : "tab"}
            onClick={() => { setTab(key); setMenuId(null); setMsg(null); }}>
            {label}
          </button>
        ))}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "1.6rem", marginTop: "2.2rem", maxWidth: "100rem" }}>

        {/* ── Routing order ── */}
        <section className="settings-card" style={{ padding: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: "1.6rem", padding: "1.6rem 1.8rem", borderBottom: "0.1rem solid var(--border)", flexWrap: "wrap" }}>
            <span className="panel-title" style={{ flex: 1, minWidth: "18rem", marginBottom: 0 }}>Routing order</span>
            <button type="button" className="btn" disabled={testing || view.chain.length === 0} onClick={() => void runTest()}>
              {testing ? "Testing…" : "Test the order"}
            </button>
            <div style={{ display: "flex", alignItems: "center", gap: "0.9rem", paddingLeft: "1.6rem", borderLeft: "0.1rem solid var(--border)" }}>
              <button type="button" role="switch" aria-checked={view.failover} aria-label="Automatic failover"
                className={view.failover ? "switch on" : "switch"}
                onClick={() => void put({ [tab]: { failover: !view.failover } })}>
                <span className="switch-knob" />
              </button>
              <span style={{ fontSize: "1.3rem", fontWeight: 550, color: "var(--text)", whiteSpace: "nowrap" }}>Automatic failover</span>
            </div>
          </div>

          {view.chain.length === 0 && (
            <p className="muted" style={{ padding: "1.6rem 1.8rem", margin: 0 }}>
              No provider connected yet — pick one below to start the order.
            </p>
          )}
          {view.chain.map((e, i) => {
            const m = meta(tab, e.provider);
            const needsKey = !e.apiKeyMasked && e.provider !== "custom";
            const isActive = e.id === activeId && !needsKey;
            const stateLabel = needsKey ? "Needs API key" : e.health === "down" ? "Unavailable" : isActive ? "Active" : "Standby";
            const stateColor = needsKey ? "var(--review)" : e.health === "down" ? "var(--danger)" : isActive ? "var(--published)" : "var(--text-2)";
            const dotBg = needsKey ? "var(--review)" : e.health === "down" ? "var(--danger)" : isActive ? "var(--published)" : "var(--surface-3)";
            return (
              <div key={e.id}>
                {i > 0 && <span style={{ display: "block", height: "0.1rem", background: "var(--border)" }} />}
                <div style={{
                  display: "flex", alignItems: "center", gap: "1.4rem", rowGap: "1rem", flexWrap: "wrap",
                  padding: "1.4rem 1.8rem",
                  background: isActive ? "var(--accent-soft)" : "transparent",
                  opacity: !view.failover && i > 0 ? 0.55 : 1,
                }}>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: "1.15rem", color: "var(--text-3)", width: "1.2rem", textAlign: "center" }}>{i + 1}</span>
                  <span style={{
                    width: "3.4rem", height: "3.4rem", flex: "none", borderRadius: "0.9rem",
                    background: m.tintBg, color: m.tint, display: "flex", alignItems: "center",
                    justifyContent: "center", fontSize: "1.3rem", fontWeight: 600,
                  }}>{m.mono}</span>
                  <div style={{ flex: "1 1 19rem", minWidth: "17rem" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "0.8rem" }}>
                      <span style={{ fontSize: "1.4rem", fontWeight: 550, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.label}</span>
                      {i === 0 && (
                        <span style={{ fontFamily: "var(--font-mono)", fontSize: "1rem", letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-2)", background: "var(--surface-2)", border: "0.1rem solid var(--border)", borderRadius: "0.4rem", padding: "0.1rem 0.5rem" }}>Primary</span>
                      )}
                    </div>
                    {e.baseUrl && (
                      <div style={{ fontFamily: "var(--font-mono)", fontSize: "1.15rem", color: "var(--text-3)", marginTop: "0.3rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.baseUrl}</div>
                    )}
                  </div>
                  {m.models.length > 0 ? (
                    <select aria-label={`${e.label} model`} value={e.model} style={{ height: "3.2rem", flex: "0 1 20rem", minWidth: "12rem", fontSize: "1.3rem" }}
                      onChange={(ev) => {
                        const arr = view.chain.map((x) => (x.id === e.id ? { ...x, model: ev.target.value } : x));
                        void saveChain(arr);
                      }}>
                      {[...new Set([e.model, ...m.models])].map((mm) => <option key={mm} value={mm}>{mm}</option>)}
                    </select>
                  ) : (
                    <code style={{ fontSize: "1.2rem", color: "var(--text-2)" }}>{e.model}</code>
                  )}
                  <div style={{ flex: "0 0 13rem", display: "flex", alignItems: "center", gap: "0.7rem" }}>
                    <span style={{ width: "0.7rem", height: "0.7rem", borderRadius: "99rem", flex: "none", background: dotBg, border: `0.1rem solid ${isActive || needsKey || e.health === "down" ? dotBg : "var(--border-strong)"}` }} />
                    <span style={{ fontSize: "1.3rem", fontWeight: 600, color: stateColor }}>{stateLabel}</span>
                  </div>
                  <div style={{ position: "relative", flex: "none" }}>
                    <button type="button" aria-label={`${e.label} actions`} className="btn"
                      style={{ width: "3rem", height: "3rem", padding: 0, border: "0.1rem solid transparent", background: "none" }}
                      onClick={() => setMenuId(menuId === e.id ? null : e.id)}>···</button>
                    {menuId === e.id && (
                      <div style={{
                        position: "absolute", top: "3.4rem", right: 0, zIndex: 20, width: "19.6rem",
                        border: "0.1rem solid var(--border)", borderRadius: "0.9rem", background: "var(--surface)",
                        boxShadow: "var(--shadow)", padding: "0.5rem", display: "flex", flexDirection: "column", gap: "0.1rem",
                      }}>
                        {([
                          ["Make primary", () => move(i, 0)],
                          ["Move up", () => move(i, i - 1)],
                          ["Move down", () => move(i, i + 1)],
                        ] as const).map(([label, fn]) => (
                          <button key={label} type="button" className="nav-item" onClick={fn}>{label}</button>
                        ))}
                        <span style={{ height: "0.1rem", background: "var(--border)", margin: "0.4rem 0" }} />
                        <button type="button" className="nav-item" style={{ color: "var(--danger)" }}
                          onClick={() => {
                            setMenuId(null);
                            void saveChain(view.chain.filter((x) => x.id !== e.id), `${e.label} disconnected`);
                          }}>Disconnect</button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}

          <div style={{ display: "flex", alignItems: "center", gap: "1rem", flexWrap: "wrap", padding: "1.3rem 1.8rem", borderTop: "0.1rem solid var(--border)", background: "var(--surface-2)", borderRadius: "0 0 var(--r) var(--r)" }}>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "1.05rem", letterSpacing: "0.09em", textTransform: "uppercase", color: "var(--text-3)" }}>Switch when</span>
            <select aria-label="Failure threshold" value={String(view.retries)} style={{ height: "3.2rem", fontSize: "1.3rem" }}
              onChange={(ev) => void put({ [tab]: { retries: Number(ev.target.value) } })}>
              <option value="1">1 failed request</option>
              <option value="2">2 consecutive failures</option>
              <option value="5">5 consecutive failures</option>
            </select>
            <span style={{ fontSize: "1.3rem", color: "var(--text-2)" }}>or a timeout of</span>
            <select aria-label="Timeout" value={String(view.timeoutSec)} style={{ height: "3.2rem", fontSize: "1.3rem" }}
              onChange={(ev) => void put({ [tab]: { timeoutSec: Number(ev.target.value) } })}>
              <option value="15">15 s</option>
              <option value="30">30 s</option>
              <option value="60">60 s</option>
            </select>
            <span style={{ fontSize: "1.3rem", color: "var(--text-2)" }}>· recheck the primary every 5 min</span>
            {msg && <span className="muted" style={{ marginLeft: "auto" }}>{msg}</span>}
          </div>
        </section>

        {/* ── Add a provider ── */}
        <section className="settings-card">
          <div style={{ display: "flex", alignItems: "baseline", gap: "1rem", flexWrap: "wrap" }}>
            <span className="panel-title" style={{ marginBottom: 0 }}>Add a provider</span>
            <p style={{ margin: 0, fontSize: "1.3rem", color: "var(--text-2)" }}>
              New connections land at the end of the routing order. You can connect as many as you like.
            </p>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(22.4rem, 1fr))", gap: "1rem", marginTop: "1.6rem" }}>
            {Object.entries(CATALOG[tab]).filter(([k]) => k !== "custom").map(([k, m]) => {
              const used = view.chain.some((e) => e.provider === k);
              return (
                <button key={k} type="button" disabled={used} onClick={() => openAdd(k)}
                  style={{
                    display: "flex", alignItems: "center", gap: "1.1rem", padding: "1.2rem", textAlign: "left",
                    border: "0.1rem solid var(--border)", borderRadius: "1rem",
                    background: used ? "var(--surface-2)" : "var(--surface)",
                    cursor: used ? "default" : "pointer", opacity: used ? 0.6 : 1, font: "inherit", color: "inherit",
                  }}>
                  <span style={{ width: "3rem", height: "3rem", flex: "none", borderRadius: "0.8rem", background: m.tintBg, color: m.tint, display: "flex", alignItems: "center", justifyContent: "center", fontSize: "1.2rem", fontWeight: 600 }}>{m.mono}</span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: "block", fontSize: "1.35rem", fontWeight: 550, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.name}</span>
                    <span style={{ display: "block", fontSize: "1.2rem", color: "var(--text-3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.sub}</span>
                  </span>
                  <span style={{ fontSize: used ? "1.15rem" : "1.6rem", color: used ? "var(--text-3)" : "var(--accent)", flex: "none", fontWeight: 500 }}>{used ? "In order" : "+"}</span>
                </button>
              );
            })}
          </div>
          <button type="button" onClick={() => openAdd("custom")}
            style={{
              display: "flex", alignItems: "center", gap: "1.2rem", width: "100%", padding: "1.4rem", marginTop: "1rem",
              border: "0.1rem dashed var(--border-strong)", borderRadius: "1rem", background: "none",
              cursor: "pointer", font: "inherit", color: "inherit", textAlign: "left",
            }}>
            <span style={{ width: "3rem", height: "3rem", flex: "none", borderRadius: "0.8rem", background: "var(--surface-2)", border: "0.1rem solid var(--border)", color: "var(--text-2)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "1.6rem" }}>+</span>
            <span style={{ fontSize: "1.35rem", fontWeight: 550 }}>Any OpenAI-compatible endpoint</span>
          </button>
        </section>

        {/* ── Routing log ── */}
        {log.length > 0 && (
          <section className="settings-card" style={{ padding: 0, overflow: "hidden" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "1rem", padding: "1.2rem 1.8rem", borderBottom: "0.1rem solid var(--border)" }}>
              <span className="panel-title" style={{ marginBottom: 0, fontSize: "1.35rem" }}>Routing log</span>
              <span style={{ flex: 1 }} />
              <span style={{ fontSize: "1.25rem", color: "var(--text-2)" }}>Most recent first</span>
            </div>
            {log.slice(0, 8).map((ev, i) => (
              <div key={i} style={{ display: "flex", alignItems: "baseline", gap: "1.2rem", padding: "0.9rem 1.8rem", borderBottom: i < Math.min(log.length, 8) - 1 ? "0.1rem solid var(--border)" : "none" }}>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: "1.15rem", color: "var(--text-3)", flex: "none" }}>{fmtTime(ev.t)}</span>
                <span style={{ width: "0.6rem", height: "0.6rem", borderRadius: "99rem", flex: "none", position: "relative", top: "-0.1rem", background: ev.kind === "ok" ? "var(--published)" : ev.kind === "warn" ? "var(--review)" : "var(--border-strong)" }} />
                <span style={{ fontSize: "1.3rem", color: "var(--text)" }}>{ev.text}</span>
              </div>
            ))}
          </section>
        )}
      </div>

      {/* ── Connect modal ── */}
      {addMeta && (
        <div className="modal-backdrop" onClick={() => setAdding(null)}>
          <div className="modal" style={{ width: "min(60rem, 92vw)" }} onClick={(e) => e.stopPropagation()}>
            <div style={{ padding: "2.4rem 2.4rem 2.2rem" }}>
              <div style={{ display: "flex", alignItems: "flex-start", gap: "1.6rem" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <h3 style={{ margin: 0, fontSize: "1.8rem", fontWeight: 600 }}>Connect {addMeta.name}</h3>
                  <p style={{ margin: "0.7rem 0 0", fontSize: "1.3rem", color: "var(--text-2)" }}>{addMeta.sub}</p>
                </div>
                <button type="button" className="btn" style={{ width: "3.4rem", height: "3.4rem", padding: 0 }} onClick={() => setAdding(null)}>✕</button>
              </div>
              <div className="form-fields" style={{ marginTop: "2rem" }}>
                {adding === "custom" && (
                  <>
                    <label className="field"><span>Display name</span>
                      <input value={fName} placeholder="Internal gateway" onChange={(e) => setFName(e.target.value)} /></label>
                    <label className="field"><span>Base URL</span>
                      <input value={fUrl} placeholder={tab === "ss" ? "https://…/v1/embeddings" : "https://llm.internal/v1"} onChange={(e) => setFUrl(e.target.value)} /></label>
                  </>
                )}
                <label className="field"><span>API key{adding === "custom" ? " (if the endpoint needs one)" : ""}</span>
                  <input type="password" value={fKey} placeholder={addMeta.keyHint} onChange={(e) => setFKey(e.target.value)} /></label>
                <label className="field"><span>Model</span>
                  {addMeta.models.length > 0 ? (
                    <select value={fModel} onChange={(e) => setFModel(e.target.value)}>
                      {addMeta.models.map((m) => <option key={m} value={m}>{m}</option>)}
                    </select>
                  ) : (
                    <input value={fModel} placeholder={addMeta.modelHint ?? "model-id"} onChange={(e) => setFModel(e.target.value)} />
                  )}
                </label>
                {adding === "anthropic" && (
                  <label className="field"><span>Workspace ID (optional)</span>
                    <input value={fWsId} placeholder="wrkspc_… — only for identity-linked keys" onChange={(e) => setFWsId(e.target.value)} />
                    <span className="widget-hint">Newer Anthropic keys are identity-linked and reject requests without their workspace id.</span>
                  </label>
                )}
                <div style={{ display: "flex", alignItems: "center", gap: "1.1rem", padding: "1.3rem 1.4rem", borderRadius: "0.8rem", background: "var(--surface-2)" }}>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: "1.1rem", fontWeight: 500, color: "var(--text-2)", background: "var(--surface)", border: "0.1rem solid var(--border)", borderRadius: "0.5rem", padding: "0.2rem 0.7rem", flex: "none" }}>#{view.chain.length + 1}</span>
                  <span style={{ fontSize: "1.3rem", color: "var(--text-2)" }}>Joins the routing order last — on standby until every provider above it fails.</span>
                </div>
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "1rem", padding: "1.6rem 2.4rem", borderTop: "0.1rem solid var(--border)" }}>
              {addMeta.docs && (
                <a href={addMeta.docs} target="_blank" rel="noreferrer" className="ai-key-link" style={{ fontSize: "1.3rem", fontWeight: 550 }}>Get an API key ↗</a>
              )}
              <span style={{ flex: 1 }} />
              <button type="button" className="btn" onClick={() => setAdding(null)}>Cancel</button>
              <button type="button" className="btn btn-primary"
                disabled={(adding !== "custom" && !fKey) || (adding === "custom" && !fUrl)}
                onClick={() => void confirmAdd()}>
                Add to order
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
