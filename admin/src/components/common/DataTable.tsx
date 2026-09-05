/**
 * Shared sortable/resizable table (user requirement 2026-08-23: every table sorts on header
 * click — asc/desc toggle — and columns resize by dragging the header edge).
 * Two sorting modes: client-side via `sortValue` (small, unpaged tables), or controlled via
 * `sort`/`onSortChange` (paged tables — the server must sort, page-local sorting lies).
 */
import { useMemo, useState, type ReactNode } from "react";

export interface DataColumn<T> {
  key: string;
  title: ReactNode;
  /** Initial width (any CSS length). Resizing overrides it with pixels. */
  width?: string;
  /** Client-mode sort accessor — presence makes the header clickable in client mode */
  sortValue?: (row: T) => string | number | null;
  /** Controlled-mode: this column is sortable (server understands its key) */
  sortable?: boolean;
  render: (row: T) => ReactNode;
  /** Extra class on tds of this column (e.g. col-check) */
  tdClass?: string;
  /** Cells that must not trigger onRowClick (checkboxes, action buttons) */
  stopRowClick?: boolean;
}

export interface SortState {
  key: string;
  dir: "asc" | "desc";
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  sort,
  onSortChange,
  emptyText = "No rows",
  loading = false,
}: {
  columns: Array<DataColumn<T>>;
  rows: T[];
  rowKey(row: T): string;
  onRowClick?(row: T): void;
  /** Provide sort+onSortChange for server-sorted (paged) tables */
  sort?: SortState | null;
  onSortChange?(sort: SortState): void;
  emptyText?: string;
  loading?: boolean;
}) {
  const controlled = !!onSortChange;
  const [localSort, setLocalSort] = useState<SortState | null>(null);
  const active = controlled ? (sort ?? null) : localSort;
  const [widths, setWidths] = useState<Record<string, number>>({});

  const isSortable = (c: DataColumn<T>) => (controlled ? !!c.sortable : !!c.sortValue);

  const toggleSort = (c: DataColumn<T>) => {
    if (!isSortable(c)) return;
    const next: SortState =
      active?.key === c.key
        ? { key: c.key, dir: active.dir === "asc" ? "desc" : "asc" }
        : { key: c.key, dir: "asc" };
    if (controlled) onSortChange!(next);
    else setLocalSort(next);
  };

  const sorted = useMemo(() => {
    if (controlled || !localSort) return rows;
    const col = columns.find((c) => c.key === localSort.key);
    if (!col?.sortValue) return rows;
    const dir = localSort.dir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const va = col.sortValue!(a);
      const vb = col.sortValue!(b);
      if (va === null || va === undefined) return 1;
      if (vb === null || vb === undefined) return -1;
      if (typeof va === "number" && typeof vb === "number") return (va - vb) * dir;
      return String(va).localeCompare(String(vb)) * dir;
    });
  }, [rows, localSort, controlled, columns]);

  const startResize = (e: React.PointerEvent, key: string) => {
    e.preventDefault();
    e.stopPropagation();
    const th = (e.target as HTMLElement).closest("th");
    if (!th) return;
    const startX = e.clientX;
    const startWidth = th.getBoundingClientRect().width;
    const onMove = (ev: PointerEvent) => {
      const w = Math.max(60, startWidth + (ev.clientX - startX));
      setWidths((prev) => ({ ...prev, [key]: w }));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <table className="data-table dt">
      <thead>
        <tr>
          {columns.map((c) => (
            <th
              key={c.key}
              style={{ width: widths[c.key] ? `${widths[c.key]}px` : c.width }}
            >
              <span className="dt-th">
                <span
                  className={isSortable(c) ? "dt-th-label sortable" : "dt-th-label"}
                  onClick={() => toggleSort(c)}
                >
                  {c.title}
                  {active?.key === c.key && (
                    <span className="dt-arrow">{active.dir === "asc" ? "▲" : "▼"}</span>
                  )}
                </span>
                <span className="dt-resizer" onPointerDown={(e) => startResize(e, c.key)} />
              </span>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {loading && rows.length === 0 && (
          <tr><td colSpan={columns.length} className="muted">Loading…</td></tr>
        )}
        {!loading && sorted.length === 0 && (
          <tr><td colSpan={columns.length} className="muted">{emptyText}</td></tr>
        )}
        {sorted.map((row) => (
          <tr
            key={rowKey(row)}
            className={onRowClick ? "row-link" : undefined}
            onClick={onRowClick ? () => onRowClick(row) : undefined}
          >
            {columns.map((c) => (
              <td
                key={c.key}
                className={c.tdClass}
                onClick={c.stopRowClick ? (e) => e.stopPropagation() : undefined}
              >
                {c.render(row)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
