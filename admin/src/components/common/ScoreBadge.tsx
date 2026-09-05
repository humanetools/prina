/** Completeness display — design thresholds: ≥90 published / ≥60 review / below is danger */

export function scoreTone(score: number): "high" | "mid" | "low" {
  if (score >= 90) return "high";
  if (score >= 60) return "mid";
  return "low";
}

export function ScoreBadge({ score }: { score: number }) {
  return <span className={`score score-${scoreTone(score)}`}>{score}%</span>;
}

/** For list cells: mini progress bar + % (design P3 Completeness column) */
export function ScoreCell({ score }: { score: number }) {
  const tone = scoreTone(score);
  return (
    <span className="score-cell">
      <span className="score-track">
        <span className={`score-fill score-fill-${tone}`} style={{ width: `${score}%`, display: "block", height: "100%" }} />
      </span>
      <span className={`score score-${tone}`}>{score}%</span>
    </span>
  );
}

export function ScoreGauge({
  score,
  missing,
}: {
  score: number;
  missing: Array<{ field: string; label?: string; reason: string }>;
}) {
  const tone = scoreTone(score);
  return (
    <div className="score-gauge">
      <div className="score-gauge-head">
        <span>Completeness</span>
        <ScoreBadge score={score} />
      </div>
      <div className="score-track">
        <div className={`score-fill score-fill-${tone}`} style={{ width: `${score}%` }} />
      </div>
      {missing.length > 0 && (
        <ul className="score-missing">
          {missing.map((m) => (
            <li key={m.field}>
              <strong>{m.label ?? m.field}</strong> — {m.reason}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
