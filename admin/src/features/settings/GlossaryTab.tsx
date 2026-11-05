/**
 * Settings › AI › Glossary (37-IMPL-translation-glossary) — the terms the locale translator
 * must honour. One row per concept, one column per registered locale (the default locale
 * first, then the rest by code — the same order as Settings › Locales). Edits are local until
 * "Save"; the whole grid is saved at once. Excel goes out and comes back through the server
 * (SheetJS lives in core, not in this bundle); an upload lands in the grid unsaved so a wrong
 * file never silently replaces the glossary.
 */
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { IconDownload, IconPlus, IconTrash, IconUpload } from "@tabler/icons-react";
import { api, apiErrorMessage, getWorkspaceSlug } from "../../api/client";
import type { AiGlossaryRow } from "../../api/types";

interface GlossaryView {
  locales: Array<{ code: string; name: string }>;
  rows: AiGlossaryRow[];
}
interface GridRow {
  /** server id, or a local "new-…" key until saved */
  key: string;
  id?: string;
  terms: Record<string, string>;
}

let seq = 0;
const newRow = (): GridRow => ({ key: `new-${++seq}`, terms: {} });
const fromServer = (rows: AiGlossaryRow[]): GridRow[] =>
  rows.map((r) => ({ key: r.id, id: r.id, terms: { ...r.terms } }));

const fileToBase64 = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

export function GlossaryTab() {
  const qc = useQueryClient();
  const { data, error } = useQuery<GlossaryView>({ queryKey: ["ai-glossary"], queryFn: () => api("/api/ai/glossary") });
  const [rows, setRows] = useState<GridRow[] | null>(null);
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // adopt the server rows whenever they arrive and nothing is being edited
  useEffect(() => {
    if (data && !dirty) setRows(fromServer(data.rows));
  }, [data, dirty]);

  if (error) return <p className="muted">{apiErrorMessage(error, "Could not load the glossary")}</p>;
  if (!data || !rows) return <p className="muted">Loading…</p>;

  const locales = data.locales;
  const edit = (fn: (prev: GridRow[]) => GridRow[]) => { setRows((prev) => fn(prev ?? [])); setDirty(true); setMsg(null); };
  const setCell = (key: string, code: string, value: string) =>
    edit((prev) => prev.map((r) => (r.key === key ? { ...r, terms: { ...r.terms, [code]: value } } : r)));
  const addRow = () => edit((prev) => [...prev, newRow()]);
  const removeRow = (key: string) => edit((prev) => prev.filter((r) => r.key !== key));
  const discard = () => { setRows(fromServer(data.rows)); setDirty(false); setMsg(null); };

  const save = async () => {
    setBusy(true);
    try {
      const body = { rows: rows.map((r) => ({ ...(r.id ? { id: r.id } : {}), terms: r.terms })) };
      const out = await api<{ rows: AiGlossaryRow[] }>("/api/ai/glossary", { method: "PUT", body });
      setRows(fromServer(out.rows));
      setDirty(false);
      setMsg(`Saved — ${out.rows.length} ${out.rows.length === 1 ? "term" : "terms"}`);
      await qc.invalidateQueries({ queryKey: ["ai-glossary"] });
    } catch (e) {
      setMsg(apiErrorMessage(e, "Save failed"));
    } finally {
      setBusy(false);
    }
  };

  const download = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/ai/glossary/export", {
        credentials: "same-origin",
        headers: { "x-prina-workspace": getWorkspaceSlug() },
      });
      if (!res.ok) throw new Error(`Download failed (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "prina-glossary.xlsx";
      a.click();
      URL.revokeObjectURL(url);
      setMsg(null);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Download failed");
    } finally {
      setBusy(false);
    }
  };

  const upload = async (file: File) => {
    setBusy(true);
    try {
      const out = await api<{ rows: Array<{ terms: Record<string, string> }>; columns: string[]; ignoredColumns: string[] }>(
        "/api/ai/glossary/parse",
        { method: "POST", body: { filename: file.name, dataBase64: await fileToBase64(file) } },
      );
      setRows(out.rows.map((r) => ({ ...newRow(), terms: r.terms })));
      setDirty(true);
      const ignored = out.ignoredColumns.length ? ` · ignored columns: ${out.ignoredColumns.join(", ")}` : "";
      setMsg(`${out.rows.length} rows loaded from ${file.name} — Save to apply, Discard to keep the current glossary${ignored}`);
    } catch (e) {
      setMsg(apiErrorMessage(e, "Could not read the file"));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>, rowIndex: number) => {
    // Enter on the last row = a new row, so a list can be typed straight down
    if (e.key === "Enter" && rowIndex === rows.length - 1) { e.preventDefault(); addRow(); }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.6rem", marginTop: "2.2rem", maxWidth: "120rem" }}>
      <section className="settings-card" style={{ padding: 0 }}>
        <div className="glossary-head">
          <div style={{ flex: 1, minWidth: "20rem" }}>
            <span className="panel-title" style={{ marginBottom: 0 }}>Glossary</span>
            <p className="glossary-desc">
              Terms the AI translator must keep — one row per concept, written in each language.
              A row applies whenever its source-language wording appears in the entry being translated.
            </p>
          </div>
          <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: "none" }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }} />
          <button type="button" className="btn" disabled={busy} onClick={() => fileRef.current?.click()}>
            <IconUpload size="1.4rem" /> Upload Excel
          </button>
          <button type="button" className="btn" disabled={busy || data.rows.length === 0} onClick={() => void download()}>
            <IconDownload size="1.4rem" /> Download Excel
          </button>
          <button type="button" className="btn" onClick={addRow}>
            <IconPlus size="1.4rem" /> Add row
          </button>
        </div>

        {locales.length === 0 ? (
          <p className="muted" style={{ padding: "1.6rem 1.8rem", margin: 0 }}>
            Register languages in Settings › Locales first — each one becomes a column here.
          </p>
        ) : (
          <div className="glossary-scroll">
            <table className="glossary-grid" aria-label="Translation glossary">
              <thead>
                <tr>
                  <th className="glossary-num">#</th>
                  {locales.map((l, i) => (
                    <th key={l.code}>
                      <span className="glossary-col-name">{i === 0 ? `${l.name} · default` : l.name}</span>
                      <span className="glossary-col-code">{l.code}</span>
                    </th>
                  ))}
                  <th className="glossary-actions" />
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={locales.length + 2} className="glossary-empty">
                      No terms yet — add a row, or upload an Excel file whose header row carries the locale codes
                      ({locales.map((l) => l.code).join(", ")}).
                    </td>
                  </tr>
                )}
                {rows.map((r, i) => (
                  <tr key={r.key}>
                    <td className="glossary-num">{i + 1}</td>
                    {locales.map((l) => (
                      <td key={l.code}>
                        <input
                          aria-label={`${l.name} term, row ${i + 1}`}
                          value={r.terms[l.code] ?? ""}
                          placeholder={l.code}
                          onChange={(e) => setCell(r.key, l.code, e.target.value)}
                          onKeyDown={(e) => onKeyDown(e, i)}
                        />
                      </td>
                    ))}
                    <td className="glossary-actions">
                      <button type="button" className="btn btn-ghost btn-icon" aria-label={`Remove row ${i + 1}`}
                        title="Remove row" onClick={() => removeRow(r.key)}>
                        <IconTrash size="1.4rem" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="glossary-foot">
          <span className="muted" style={{ flex: 1, minWidth: "16rem" }}>
            {msg ?? (dirty ? "Unsaved changes" : `${data.rows.length} ${data.rows.length === 1 ? "term" : "terms"} saved`)}
          </span>
          <button type="button" className="btn" disabled={!dirty || busy} onClick={discard}>Discard</button>
          <button type="button" className="btn btn-primary" disabled={!dirty || busy} onClick={() => void save()}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </section>
    </div>
  );
}
