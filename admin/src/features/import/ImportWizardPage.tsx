/** Import wizard (P6, T7.1) — ①upload ②mapping (+AI type suggestion) ③validation report ④run & results */
import { useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { IconCheck, IconChevronLeft, IconSparkles, IconUpload } from "@tabler/icons-react";
import { api, ApiError } from "../../api/client";
import { useContentTypes } from "../../hooks/queries";
import { SectionLayout } from "../../layout/SectionLayout";
import { TypeNav } from "../content-manager/TypeNav";
import { AiDraftReviewModal, type AiDraft } from "../ctb/AiDraftReviewModal";

interface Parsed {
  columns: string[];
  columnSamples: Record<string, unknown[]>;
  rows: Record<string, unknown>[];
  totalRows: number;
  truncated: boolean;
}
interface ValidationReport {
  total: number;
  validCount: number;
  errors: Array<{ row: number; issues: string[] }>;
}
interface ExecResult {
  createdCount: number;
  failed: Array<{ index: number; error: string }>;
}

export function ImportWizardPage() {
  const { typeUid } = useParams<{ typeUid: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: types } = useContentTypes();
  const contentType = types?.find((t) => t.uid === typeUid);

  const fileInput = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [report, setReport] = useState<ValidationReport | null>(null);
  const [result, setResult] = useState<ExecResult | null>(null);
  const [aiDraft, setAiDraft] = useState<{ draft: AiDraft; issues: string[] } | null>(null);

  const fields = contentType?.definition.fields ?? [];

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Request failed");
    } finally {
      setBusy(false);
    }
  };

  const upload = (file: File) =>
    run(async () => {
      const buf = new Uint8Array(await file.arrayBuffer());
      let bin = "";
      for (let i = 0; i < buf.length; i += 0x8000) {
        bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      }
      const data = await api<Parsed>("/api/import/parse", {
        method: "POST",
        body: { filename: file.name, dataBase64: btoa(bin) },
      });
      setParsed(data);
      // Auto-mapping suggestion: column name == field name/label
      const auto: Record<string, string> = {};
      for (const col of data.columns) {
        const hit = fields.find(
          (f) => f.name.toLowerCase() === col.toLowerCase() || f.label === col,
        );
        if (hit) auto[col] = hit.name;
      }
      setMapping(auto);
      setStep(2);
    });

  const validate = () =>
    run(async () => {
      const data = await api<ValidationReport>("/api/import/validate", {
        method: "POST",
        body: { typeUid, mapping, rows: parsed!.rows },
      });
      setReport(data);
      setStep(3);
    });

  const execute = () =>
    run(async () => {
      const data = await api<ExecResult>("/api/import/execute", {
        method: "POST",
        body: { typeUid, mapping, rows: parsed!.rows },
      });
      setResult(data);
      await qc.invalidateQueries({ queryKey: ["entries", typeUid] });
      setStep(4);
    });

  const proposeFromColumns = () =>
    run(async () => {
      const data = await api<{ draft: AiDraft; issues: string[] }>(
        "/api/ai/schema-propose",
        {
          method: "POST",
          body: {
            columns: parsed!.columns.map((name) => ({
              name,
              samples: parsed!.columnSamples[name] ?? [],
            })),
          },
        },
      );
      setAiDraft(data);
    });

  const failedRowsCsv = () => {
    if (!result || !parsed) return;
    const lines = [parsed.columns.join(",")];
    for (const f of result.failed) {
      const row = parsed.rows[f.index]!;
      lines.push(parsed.columns.map((c) => JSON.stringify(row[c] ?? "")).join(","));
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "failed-rows.csv";
    a.click();
  };

  const STEPS = ["Upload file", "Map columns → fields", "Validation report", "Run · result"];

  return (
    <SectionLayout panelTitle="Content Manager" panel={<TypeNav />}>
      <div className="breadcrumb">
        <Link to={`/content/${typeUid}`}><IconChevronLeft size="1.5rem" /> {contentType?.name ?? typeUid}</Link>
        <span>/</span><strong>Import</strong>
      </div>
      <ol className="stepper" style={{ marginBottom: "var(--space-4)" }}>
        {STEPS.map((s, i) => (
          <li key={s} className={i + 1 < step ? "done" : i + 1 === step ? "current" : ""}>
            {i + 1 < step ? <IconCheck size="1.3rem" /> : i + 1} {s}
          </li>
        ))}
      </ol>
      {error && <div className="form-error">{error}</div>}

      {step === 1 && (
        <div className="empty-state">
          <p>Upload a CSV or Excel (xlsx) file. The first row must be column names.</p>
          <button className="btn btn-primary" disabled={busy} onClick={() => fileInput.current?.click()}>
            <IconUpload size="1.5rem" /> {busy ? "Parsing…" : "Choose file"}
          </button>
          <input ref={fileInput} type="file" accept=".csv,.xlsx,.xls" hidden
            onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
        </div>
      )}

      {step === 2 && parsed && (
        <>
          <div className="page-head">
            <span className="muted">
              {parsed.totalRows} rows detected{parsed.truncated && " (up to 500 rows processed)"}
            </span>
            <button className="btn" disabled={busy} onClick={() => void proposeFromColumns()}
              title="Let AI propose a new type from these columns (requires BYOK setup)">
              <IconSparkles size="1.5rem" /> Make a new type from this file (AI)
            </button>
          </div>
          <table className="data-table narrow">
            <thead>
              <tr><th>Column</th><th>Sample</th><th>→ Field</th></tr>
            </thead>
            <tbody>
              {parsed.columns.map((col) => (
                <tr key={col}>
                  <td><strong>{col}</strong></td>
                  <td className="col-meta">
                    {(parsed.columnSamples[col] ?? []).slice(0, 3).map(String).join(", ")}
                  </td>
                  <td>
                    <select value={mapping[col] ?? ""}
                      onChange={(e) =>
                        setMapping((m) => {
                          const next = { ...m };
                          if (e.target.value) next[col] = e.target.value;
                          else delete next[col];
                          return next;
                        })
                      }>
                      <option value="">(ignore)</option>
                      {fields.map((f) => (
                        <option key={f.name} value={f.name}>{f.label ?? f.name}</option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="row-gap" style={{ marginTop: "var(--space-3)" }}>
            <button className="btn btn-primary" disabled={busy || Object.keys(mapping).length === 0}
              onClick={() => void validate()}>
              Validate →
            </button>
          </div>
        </>
      )}

      {step === 3 && report && (
        <>
          <div className={report.errors.length ? "form-error" : "widget-hint"}>
            {report.validCount}/{report.total} rows valid
            {report.errors.length > 0 && ` — Error ${report.errors.length}Row (rows with errors are skipped)`}
          </div>
          {report.errors.length > 0 && (
            <table className="data-table narrow" style={{ margin: "var(--space-3) 0" }}>
              <thead><tr><th>Row</th><th>Error</th></tr></thead>
              <tbody>
                {report.errors.slice(0, 50).map((e) => (
                  <tr key={e.row}>
                    <td>{e.row + 1}</td>
                    <td className="col-meta">{e.issues.join(" · ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="row-gap">
            <button className="btn" onClick={() => setStep(2)}>← Edit mapping</button>
            <button className="btn btn-primary" disabled={busy || report.validCount === 0}
              onClick={() => void execute()}>
              {busy ? "Importing…" : `Import ${report.validCount} rows`}
            </button>
          </div>
        </>
      )}

      {step === 4 && result && (
        <div className="empty-state">
          <IconCheck size="3.6rem" color="var(--status-published)" />
          <h2>{result.createdCount} entries imported</h2>
          {result.failed.length > 0 && (
            <p>
              {result.failed.length} failed —{" "}
              <button className="link-btn" onClick={failedRowsCsv}>Download failed rows as CSV</button>
            </p>
          )}
          <button className="btn btn-primary" onClick={() => navigate(`/content/${typeUid}`)}>
            Back to list
          </button>
        </div>
      )}

      {aiDraft && (
        <AiDraftReviewModal
          draft={aiDraft.draft}
          issues={aiDraft.issues}
          onClose={() => setAiDraft(null)}
          onCreated={(uid) => {
            setAiDraft(null);
            navigate(`/content/${uid}/import`);
            setStep(2);
          }}
        />
      )}
    </SectionLayout>
  );
}
