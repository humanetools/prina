/**
 * Edit view right panel (336px full-height panel) — save/preview · completeness · workflow chain · activity · versions
 * Design: sections separated by inset hairlines; guard-blocked transitions show a lock card including the reason.
 */
import { EntryStatus, type Completeness, type Entry, type PublishAdvisory } from "../../api/types";
import { useAuth } from "../../auth/AuthProvider";
import { useWorkflow } from "../../hooks/queries";
import { adminEe } from "../../ee-loader";
import { scoreTone } from "../../components/common/ScoreBadge";

/** Workflow seeds differ per edition (OSS 2-stage, EE 4-stage) — the chain is derived from server state */
const FALLBACK_CHAIN: EntryStatus[] = [EntryStatus.Draft, EntryStatus.Published];

export function RightPanel({
  entry,
  completeness,
  advisories = [],
  blockPublish = false,
  dirty,
  onSave,
  onTransition,
  onShowVersions,
  onShowPreview,
  busy,
}: {
  entry: Entry;
  completeness: Completeness;
  /** SEO/a11y publish checks (§0.11) — empty for types without the SEO option */
  advisories?: PublishAdvisory[];
  /** Strict mode with error advisories — Publish disabled (server enforces too) */
  blockPublish?: boolean;
  dirty: boolean;
  onSave(): void;
  onTransition(to: string): void;
  onShowVersions(): void;
  onShowPreview(): void;
  busy: boolean;
}) {
  const { state } = useAuth();
  const { data: workflow } = useWorkflow();
  const chain = (workflow?.states as EntryStatus[] | undefined) ?? FALLBACK_CHAIN;

  const myRoleIds =
    state.status === "authed"
      ? new Set(state.me.memberships.map((m) => m.roleId))
      : new Set<string>();
  const isInstanceAdmin = state.status === "authed" && state.me.user.isInstanceAdmin;

  const available = (workflow?.transitions ?? []).filter(
    (t) => t.fromState === entry.status,
  );
  const forward = available.filter(
    (t) => chain.indexOf(t.toState as EntryStatus) > chain.indexOf(entry.status),
  );
  const lockedOf = (t: { allowedRoleIds: string[] | null }) =>
    !isInstanceAdmin &&
    t.allowedRoleIds !== null &&
    !t.allowedRoleIds.some((r) => myRoleIds.has(r));

  const tone = scoreTone(completeness.score);
  const toneColor = `var(--${tone === "high" ? "published" : tone === "mid" ? "review" : "danger"})`;

  return (
    <aside className="right-panel">
      <section className="panel-section">
        <div style={{ display: "flex", gap: "0.8rem" }}>
          <button
            className="btn btn-primary"
            style={{ flex: 1, height: "4rem", justifyContent: "center" }}
            disabled={!dirty || busy}
            onClick={onSave}
          >
            {busy ? "Saving…" : "Save"}
          </button>
          <button className="btn" style={{ height: "4rem" }} onClick={onShowPreview}>
            Preview
          </button>
        </div>
        {dirty && <div className="panel-dirty">Unsaved changes</div>}
      </section>

      <section className="panel-section">
        <div className="panel-comp-head">
          <span className="panel-title">Completeness</span>
          <span className="panel-comp-pct" style={{ color: toneColor }}>
            {completeness.score}%
          </span>
        </div>
        <div className="panel-comp-track">
          <div
            style={{
              height: "100%",
              width: `${completeness.score}%`,
              background: toneColor,
              borderRadius: "var(--r-pill)",
            }}
          />
        </div>
        {completeness.missing.length === 0 ? (
          <div className="panel-comp-item ok">
            <span className="dot-mark" />
            <span>All required fields complete</span>
          </div>
        ) : (
          completeness.missing.map((m) => (
            <div key={m.field} className="panel-comp-item">
              <span className="dot-mark" />
              <span>
                {m.label ?? m.field} — {m.reason}
              </span>
            </div>
          ))
        )}
      </section>

      {advisories.length > 0 && (
        <section className="panel-section">
          <div className="panel-title">Publish checks</div>
          {advisories.map((a) => (
            <div key={a.code} className="panel-comp-item">
              <span
                className="dot-mark"
                style={{ background: a.severity === "error" ? "var(--danger)" : "var(--review)" }}
              />
              <span>{a.message}</span>
            </div>
          ))}
        </section>
      )}

      <section className="panel-section">
        <div className="panel-title">Workflow</div>
        <div className="wf-chain">
          {chain.map((s) => (
            <span
              key={s}
              className={`wf-chain-step ${s}${entry.status === s ? " on" : ""}`}
            >
              {s}
            </span>
          ))}
        </div>
        <div className="transition-list">
          {forward.map((t) => {
            const locked = lockedOf(t);
            if (locked) {
              return adminEe ? (
                <adminEe.TransitionLockCard key={t.id} toState={t.toState} />
              ) : (
                <button key={t.id} className="wf-next" disabled>
                  <span className="dot-state" />
                  {t.toState}
                </button>
              );
            }
            const publishBlocked = blockPublish && t.toState === EntryStatus.Published;
            return (
              <button
                key={t.id}
                className="wf-next"
                disabled={busy || publishBlocked}
                title={publishBlocked ? "SEO checks must pass before publishing (strict mode)" : undefined}
                onClick={() => onTransition(t.toState)}
              >
                <span className="dot-state" />
                {t.toState === EntryStatus.Published ? "Publish" : `${t.toState}`}
              </button>
            );
          })}
          {forward.length === 0 && (
            <span className="widget-hint">No transitions available</span>
          )}
        </div>
      </section>

      {/* Edition slot — per-entry chatbot exclusion (renders nothing in OSS) */}
      {adminEe?.ChatbotEntryToggle && <adminEe.ChatbotEntryToggle entryId={entry.id} />}

      {adminEe && <adminEe.EntryActivitySection entryId={entry.id} />}

      {adminEe && <adminEe.VersionHistoryButton onClick={onShowVersions} />}
    </aside>
  );
}
