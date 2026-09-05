/** Workflow status pill — status color system (design brief §2.2, consistent across all screens) */
import { EntryStatus } from "../../api/types";

const LABELS: Record<string, string> = {
  [EntryStatus.Draft]: "Draft",
  [EntryStatus.Review]: "Review",
  [EntryStatus.Approved]: "Approved",
  [EntryStatus.Published]: "Published",
};

export function StatusPill({ status }: { status: string }) {
  return (
    <span className={`pill pill-${status}`}>{LABELS[status] ?? status}</span>
  );
}
