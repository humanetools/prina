/** Overlay contrast block (§0.11 4b) — text-over-image AA verdicts from the DAM analysis */
import { api } from "../../api/client";
import type { AssetAnalysis, AssetDetail, RegionStat } from "../../api/types";
import { useInvalidatingMutation } from "../../hooks/queries";

/** Region rows: is white/black overlay text readable there? (AA large-text 3:1 baseline) */
const REGIONS: Array<{ key: keyof Pick<AssetAnalysis, "top" | "middle" | "bottom">; label: string }> = [
  { key: "top", label: "Top third" },
  { key: "middle", label: "Middle" },
  { key: "bottom", label: "Bottom third" },
];

function Verdict({ ratio }: { ratio: number }) {
  const pass = ratio >= 4.5 ? "AA" : ratio >= 3 ? "AA-large" : null;
  return (
    <span
      className="mono"
      style={{ color: pass ? "var(--published)" : "var(--danger)", whiteSpace: "nowrap" }}
    >
      {ratio.toFixed(1)}:1{pass ? ` ${pass}` : " fail"}
    </span>
  );
}

function RegionRow({ label, stat }: { label: string; stat: RegionStat }) {
  return (
    <div className="panel-comp-item" style={{ justifyContent: "space-between" }}>
      <span>{label}</span>
      <span style={{ display: "flex", gap: "1rem" }}>
        <span title="White text over this region">◻ <Verdict ratio={stat.whiteContrast} /></span>
        <span title="Black text over this region">◼ <Verdict ratio={stat.blackContrast} /></span>
      </span>
    </div>
  );
}

export function ContrastBlock({ detail }: { detail: AssetDetail }) {
  const analysis = detail.metadata.analysis as AssetAnalysis | undefined;
  const analyze = useInvalidatingMutation(
    () => api(`/api/assets/${detail.id}/analyze`, { method: "POST" }),
    [["asset", detail.id], ["assets"]],
  );

  if (!detail.mime.startsWith("image/")) return null;
  return (
    <section className="panel-section">
      <div className="panel-title">Overlay contrast</div>
      {analysis ? (
        <>
          <div className="panel-comp-item" style={{ justifyContent: "space-between" }}>
            <span>Dominant color</span>
            <span style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
              <span
                style={{
                  width: "1.6rem",
                  height: "1.6rem",
                  borderRadius: "0.4rem",
                  background: analysis.dominant,
                  border: "0.1rem solid var(--border)",
                }}
              />
              <code>{analysis.dominant}</code>
            </span>
          </div>
          {REGIONS.map((r) => (
            <RegionRow key={r.key} label={r.label} stat={analysis[r.key]} />
          ))}
          <p className="widget-hint">
            ◻ white / ◼ black overlay text vs the region's average luminance — averages can hide
            local extremes, treat as guidance.
          </p>
        </>
      ) : (
        <>
          <p className="widget-hint">Not analyzed yet (uploaded before this feature).</p>
          <button
            className="btn btn-sm"
            disabled={analyze.isPending}
            onClick={() => analyze.mutate(undefined)}
          >
            {analyze.isPending ? "Analyzing…" : "Analyze"}
          </button>
          {analyze.isError && (
            <p className="widget-hint" style={{ color: "var(--danger)" }}>
              Analysis failed — the image may be undecodable.
            </p>
          )}
        </>
      )}
    </section>
  );
}
