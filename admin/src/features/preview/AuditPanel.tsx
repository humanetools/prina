/** Preview audit results panel (§0.11) — grouped findings, click to highlight in the preview */
import { useMemo, useState } from "react";
import type { AuditFinding } from "../../api/types";
import type { ClientFinding } from "./shadow-audit";

const GROUPS: Array<{ key: string; label: string; match(rule: string): boolean }> = [
  { key: "contrast", label: "Contrast", match: (r) => r.startsWith("contrast") },
  { key: "alt", label: "Alt text", match: (r) => r === "img-alt-missing" },
  { key: "meta", label: "Meta", match: (r) => r.startsWith("seo-") },
  { key: "structure", label: "Structure", match: () => true },
];

const DOT: Record<AuditFinding["severity"], string> = {
  error: "var(--danger)",
  warn: "var(--review)",
  manual: "var(--muted, #999)",
};

export function AuditPanel({
  findings,
  checkedCount,
  onLocate,
}: {
  findings: ClientFinding[];
  /** Contrast elements measured — distinguishes "clean" from "nothing to check" */
  checkedCount: number;
  onLocate?(finding: ClientFinding): void;
}) {
  const [open, setOpen] = useState(true);
  const grouped = useMemo(() => {
    const seen = new Set<ClientFinding>();
    return GROUPS.map((g) => {
      const items = findings.filter((f) => !seen.has(f) && g.match(f.rule));
      items.forEach((f) => seen.add(f));
      return { ...g, items };
    }).filter((g) => g.items.length > 0);
  }, [findings]);

  const errors = findings.filter((f) => f.severity === "error").length;
  const warns = findings.filter((f) => f.severity === "warn").length;
  const manual = findings.filter((f) => f.severity === "manual").length;

  return (
    <div className="audit-panel">
      <button className="panel-row audit-head" onClick={() => setOpen((o) => !o)}>
        <span className="panel-title">Checks · SEO &amp; accessibility</span>
        <span className="widget-hint">
          {findings.length === 0
            ? `clean (${checkedCount} text elements measured)`
            : [
                errors && `${errors} error${errors > 1 ? "s" : ""}`,
                warns && `${warns} warning${warns > 1 ? "s" : ""}`,
                manual && `${manual} manual`,
              ]
                .filter(Boolean)
                .join(" · ")}
          {" "}{open ? "▾" : "▸"}
        </span>
      </button>
      {open &&
        grouped.map((g) => (
          <div key={g.key} className="audit-group">
            <div className="widget-hint" style={{ fontWeight: 600, margin: "0.6rem 0 0.2rem" }}>
              {g.label}
            </div>
            {g.items.map((f, i) => (
              <div
                key={`${f.rule}-${i}`}
                className="panel-comp-item"
                style={onLocate && (f.el || f.selectorPath) ? { cursor: "pointer" } : undefined}
                onClick={() => onLocate?.(f)}
                title={f.selectorPath}
              >
                <span className="dot-mark" style={{ background: DOT[f.severity] }} />
                <span>
                  {f.message}
                  {f.snippet && (
                    <>
                      {" "}
                      <code style={{ fontSize: "1.1rem" }}>{f.snippet}</code>
                    </>
                  )}
                </span>
              </div>
            ))}
          </div>
        ))}
      {open && (
        <p className="widget-hint" style={{ marginTop: "0.6rem" }}>
          Preview audit is advisory — the embedded page's real styles can differ. Contrast over
          images needs a manual check.
        </p>
      )}
    </div>
  );
}
