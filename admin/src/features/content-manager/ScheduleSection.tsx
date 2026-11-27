/**
 * Content Manager right panel — scheduled publish / unpublish (54-IMPL).
 * A schedule runs the ordinary transition at its moment with the rights of the person who set it, so
 * everything that would stop the button then (permissions, the workflow, required fields) stops the
 * schedule too — the reason is shown here afterwards.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { IconClock, IconX } from "@tabler/icons-react";
import { api, apiErrorMessage } from "../../api/client";
import { EntryStatus, type Entry } from "../../api/types";
import { Modal } from "../../components/common/Modal";
import { formatDate } from "./format";

type Action = "publish" | "unpublish";
interface Schedule {
  id: string; action: Action; runAt: string; status: "pending" | "running" | "done" | "failed";
  scheduledByLabel: string | null; executedAt: string | null; error: string | null;
}
const LABEL: Record<Action, string> = { publish: "Publish", unpublish: "Unpublish" };

/** datetime-local wants "YYYY-MM-DDTHH:mm" in local time */
function localInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
/** Tomorrow 09:00 — the usual "goes live in the morning" */
function defaultMoment(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return localInput(d);
}

export function ScheduleDialog({
  title, actions, initialAction, busy, error, onSubmit, onClose,
}: {
  title: string;
  /** which actions can be picked; one = no choice shown */
  actions: Action[];
  initialAction: Action;
  busy: boolean;
  error: string | null;
  onSubmit(action: Action, runAt: string): void;
  onClose(): void;
}) {
  const [action, setAction] = useState<Action>(initialAction);
  const [when, setWhen] = useState(defaultMoment);
  const moment = when ? new Date(when) : null;
  const inPast = !!moment && moment.getTime() <= Date.now();
  return (
    <Modal title={title} onClose={onClose}>
      <div className="form-fields">
        {actions.length > 1 && (
          <div className="field">
            <span>What happens</span>
            {actions.map((a) => (
              <label key={a} className="check">
                <input type="radio" name="schedule-action" checked={action === a} onChange={() => setAction(a)} />
                {a === "publish" ? "Publish at this moment" : "Unpublish at this moment (back to draft)"}
              </label>
            ))}
          </div>
        )}
        <label className="field">
          <span>When — your local time ({Intl.DateTimeFormat().resolvedOptions().timeZone})</span>
          <input type="datetime-local" value={when} min={localInput(new Date())} onChange={(e) => setWhen(e.target.value)} />
        </label>
        {inPast && <div className="form-error">Choose a moment in the future</div>}
        {error && <div className="form-error">{error}</div>}
        <div className="row-gap" style={{ justifyContent: "flex-end" }}>
          <button className="btn dialog-cancel" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || !moment || inPast} onClick={() => onSubmit(action, moment!.toISOString())}>
            Schedule
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function ScheduleSection({ entry, typeUid }: { entry: Entry; typeUid: string }) {
  const qc = useQueryClient();
  const key = ["entry-schedules", entry.id];
  const { data } = useQuery({
    queryKey: key,
    queryFn: () => api<{ waiting: Schedule[]; recent: Schedule[] }>(`/api/workflow/schedules?typeUid=${encodeURIComponent(typeUid)}&entryId=${entry.id}`),
    refetchInterval: 60_000,
  });
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: key });
  };
  const set = async (action: Action, runAt: string) => {
    setBusy(true); setError(null);
    try {
      await api("/api/workflow/schedules", { method: "PUT", body: { typeUid, entryId: entry.id, action, runAt } });
      await refresh();
      setOpen(false);
    } catch (e) {
      setError(apiErrorMessage(e, "Could not schedule"));
    } finally {
      setBusy(false);
    }
  };
  const cancel = async (id: string) => {
    setError(null);
    try {
      await api(`/api/workflow/schedules/${id}`, { method: "DELETE" });
      await refresh();
    } catch (e) {
      setError(apiErrorMessage(e, "Could not cancel"));
    }
  };

  const published = entry.status === EntryStatus.Published;
  // the last outcome matters only while it is a failure nobody has acted on
  const failed = data?.recent[0]?.status === "failed" ? data.recent[0] : null;

  return (
    <section className="panel-section">
      <div className="panel-title">Schedule</div>
      {data?.waiting.map((s) => (
        <div key={s.id} className="schedule-row">
          <IconClock size="1.5rem" />
          <span className="schedule-text">
            <strong>{LABEL[s.action]}</strong> {formatDate(s.runAt)}
            {s.scheduledByLabel && <span className="muted"> · {s.scheduledByLabel}</span>}
          </span>
          {s.status === "pending" && (
            <button className="btn btn-ghost btn-icon" aria-label="Cancel this schedule" title="Cancel this schedule" onClick={() => void cancel(s.id)}>
              <IconX size="1.4rem" />
            </button>
          )}
        </div>
      ))}
      {failed && (
        <p className="widget-hint danger">
          Scheduled {LABEL[failed.action].toLowerCase()} on {formatDate(failed.runAt)} did not run: {failed.error}
        </p>
      )}
      <button className="btn btn-block" onClick={() => { setError(null); setOpen(true); }}>
        <IconClock size="1.5rem" /> Schedule…
      </button>
      {error && !open && <div className="form-error">{error}</div>}
      {open && (
        <ScheduleDialog
          title="Schedule this entry"
          actions={["publish", "unpublish"]}
          initialAction={published ? "unpublish" : "publish"}
          busy={busy}
          error={error}
          onSubmit={(action, runAt) => void set(action, runAt)}
          onClose={() => setOpen(false)}
        />
      )}
    </section>
  );
}
