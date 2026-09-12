/** CM List view (P3, T3.3) — schema-driven columns, completeness, filters, bulk actions */
import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { IconCopy, IconFileImport, IconPlus, IconTemplate, IconTrash, IconX } from "@tabler/icons-react";
import { api } from "../../api/client";
import { EntryStatus, type Entry } from "../../api/types";
import {
  useContentTypes,
  useEntries,
  useInvalidatingMutation,
  useLocales,
  useWorkflow,
} from "../../hooks/queries";
import { SectionLayout } from "../../layout/SectionLayout";
import { StatusPill } from "../../components/common/StatusPill";
import { DataTable, type SortState } from "../../components/common/DataTable";
import { ScoreCell } from "../../components/common/ScoreBadge";
import { ActorChip } from "../../components/common/ActorChip";
import { EmptyHero, EntryListArt } from "../../components/common/EmptyHero";
import { TypeNav } from "./TypeNav";
import { formatDate, displayValue, effectiveDisplayField, entryLabel } from "./format";

/**
 * Status segment filter (design P3) — built from the workspace's workflow, not hardcoded.
 * The core workflow is draft↔published, so Review and Approved were filtering for states no
 * entry could ever hold; the 4-state chain only exists where EE seeds it. Falling back to
 * draft/published keeps the bar sensible before the workflow query resolves.
 */
const STATUS_LABELS: Record<string, string> = {
  [EntryStatus.Draft]: "Draft",
  [EntryStatus.Review]: "Review",
  [EntryStatus.Approved]: "Approved",
  [EntryStatus.Published]: "Published",
};
const FALLBACK_STATES: string[] = [EntryStatus.Draft, EntryStatus.Published];

function statusFilters(states: string[] | undefined): Array<{ value: string; label: string }> {
  const list = states?.length ? states : FALLBACK_STATES;
  return [
    { value: "", label: "All" },
    ...list.map((state) => ({ value: state, label: STATUS_LABELS[state] ?? state })),
  ];
}

export function ContentListPage() {
  const { typeUid } = useParams<{ typeUid: string }>();
  const navigate = useNavigate();
  const { data: types } = useContentTypes();
  const { data: workflow } = useWorkflow();
  const { data: locales } = useLocales();
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [locale, setLocale] = useState("");
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<SortState>({ key: "updatedAt", dir: "desc" });
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const contentType = types?.find((t) => t.uid === typeUid);
  const contentTypeDisplayField = contentType
    ? effectiveDisplayField(contentType.definition) ?? undefined
    : undefined;
  // Explicit search (Enter) — server-side over search_text, all pages. No live debounce:
  // simpler, and immune to IME-composition re-render issues by construction.
  const params = useMemo(() => {
    const p: Record<string, string> = { page: String(page), pageSize: "20" };
    if (status) p.status = status;
    if (locale) p.locale = locale;
    if (search.trim()) p.search = search.trim();
    p.sort = `${sort.key}:${sort.dir}`;
    return p;
  }, [page, status, locale, search, sort]);
  const { data, isLoading } = useEntries(typeUid, params);
  const rows = data?.items ?? [];

  /** Hero only when truly empty without filters (keep the table when filters yield 0 rows) */
  const pristineEmpty =
    !!data && data.pagination.total === 0 && !status && !locale && !search.trim();

  const duplicate = useInvalidatingMutation(
    (id: string) =>
      api<{ entry: Entry }>(`/api/content/${typeUid}/${id}/duplicate`, { method: "POST", body: {} }),
    [["entries", typeUid!]],
  );

  const bulkDelete = useInvalidatingMutation(
    async (ids: string[]) => {
      for (const id of ids) {
        await api(`/api/content/${typeUid}/${id}`, { method: "DELETE" });
      }
    },
    [["entries", typeUid!]],
  );

  if (!contentType) {
    return (
      <SectionLayout panelTitle="Content Manager" panel={<TypeNav />}>
        <div className="empty-state"><p>Select a type.</p></div>
      </SectionLayout>
    );
  }

  const displayField = contentTypeDisplayField;
  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <SectionLayout panelTitle="Content Manager" panel={<TypeNav />}>
      <div className="page-head">
        <div>
          <h1>{contentType.name}</h1>
          <span className="muted">
            {data ? `${rows.length} of ${data.pagination.total} entries` : "…"}
          </span>
        </div>
        <div className="row-gap">
          <Link to={`/content/${typeUid}/import`} className="btn">
            <IconFileImport size="1.5rem" /> Import
          </Link>
          <Link to={`/templates/${typeUid}`} className="btn" title="Presentation authoring — template editor">
            <IconTemplate size="1.5rem" /> Edit template
          </Link>
          <Link to={`/content/${typeUid}/new`} className="btn btn-primary">
            <IconPlus size="1.5rem" /> New entry
          </Link>
        </div>
      </div>

      {pristineEmpty ? (
        <EmptyHero
          art={<EntryListArt />}
          title={`No ${contentType.name} entries yet`}
          copy="Create the first entry by hand, or bring existing data in from a CSV or Excel file — validation and versioning apply either way."
          actions={
            <>
              <Link to={`/content/${typeUid}/new`} className="btn btn-primary">
                <IconPlus size="1.5rem" /> New entry
              </Link>
              <Link to={`/content/${typeUid}/import`} className="btn">
                <IconFileImport size="1.5rem" /> Import
              </Link>
            </>
          }
        />
      ) : (
      <>
      <div className="filter-bar">
        <div className="search-box">
          <svg width="1.4rem" height="1.4rem" viewBox="0 0 14 14" fill="none" stroke="var(--text-3)" strokeWidth="1.6">
            <circle cx="6.2" cy="6.2" r="4" />
            <path d="M9.2 9.2 12 12" />
          </svg>
          <input
            placeholder="Search entries — press Enter"
            // Uncontrolled: the DOM owns the text until the user submits with Enter
            defaultValue={search}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                setSearch(e.currentTarget.value);
                setPage(1);
              }
            }}
          />
        </div>
        <div className="seg-filter">
          {statusFilters(workflow?.states).map((f) => (
            <button
              key={f.value}
              className={status === f.value ? "active" : ""}
              onClick={() => { setStatus(f.value); setPage(1); }}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="select-box">
          Locale:
          <select value={locale} onChange={(e) => { setLocale(e.target.value); setPage(1); }}>
            <option value="">All</option>
            {(locales ?? []).map((l) => (
              <option key={l.code} value={l.code}>{l.code}</option>
            ))}
          </select>
        </div>
        {selected.size > 0 && (
          <div className="bulk-bar">
            <span>{selected.size} selected</span>
            <button
              className="btn btn-danger"
              onClick={() => {
                if (confirm(`Delete ${selected.size} entries?`)) {
                  bulkDelete.mutate([...selected], { onSuccess: () => setSelected(new Set()) });
                }
              }}
            >
              <IconTrash size="1.3rem" /> Delete
            </button>
            <button className="btn btn-icon" onClick={() => setSelected(new Set())} aria-label="Clear selection">
              <IconX size="1.3rem" />
            </button>
          </div>
        )}
      </div>

      <DataTable
        columns={[
          {
            key: "check",
            title: "",
            width: "3.6rem",
            tdClass: "col-check",
            stopRowClick: true,
            render: (entry: Entry) => (
              <input
                type="checkbox"
                checked={selected.has(entry.id)}
                onChange={() => toggle(entry.id)}
              />
            ),
          },
          {
            key: "display",
            title: displayField ? "Name" : "ID",
            sortable: true,
            tdClass: "col-title",
            render: (entry: Entry) => entryLabel(contentType.definition, entry.values, entry.id),
          },
          {
            key: "status",
            title: "Status",
            width: "13rem",
            sortable: true,
            render: (entry: Entry) => <StatusPill status={entry.status} />,
          },
          {
            key: "completeness",
            title: "Completeness",
            width: "19rem",
            sortable: true,
            render: (entry: Entry) =>
              entry.completeness ? <ScoreCell score={entry.completeness.score} /> : "—",
          },
          {
            key: "locale",
            title: "Locale",
            width: "11rem",
            sortable: true,
            render: (entry: Entry) => <code>{entry.locale}</code>,
          },
          {
            key: "updatedAt",
            title: "Last update",
            width: "22rem",
            sortable: true,
            tdClass: "col-meta",
            render: (entry: Entry) => (
              <>
                {formatDate(entry.updatedAt)}{" "}
                <ActorChip actorType={entry.updatedBy ? "human" : "system"} />
              </>
            ),
          },
          {
            key: "actions",
            title: "",
            width: "4.4rem",
            stopRowClick: true,
            render: (entry: Entry) => (
              <button
                className="btn btn-ghost btn-icon" title="Duplicate entry"
                disabled={duplicate.isPending}
                onClick={() =>
                  duplicate.mutate(entry.id, {
                    onSuccess: (r) => navigate(`/content/${typeUid}/${r.entry.id}`),
                  })
                }
              >
                <IconCopy size="1.4rem" />
              </button>
            ),
          },
        ]}
        rows={rows}
        rowKey={(entry: Entry) => entry.id}
        onRowClick={(entry: Entry) => navigate(`/content/${typeUid}/${entry.id}`)}
        sort={sort}
        onSortChange={(next) => { setSort(next); setPage(1); }}
        loading={isLoading}
        emptyText="No entries match"
      />

      {data && (data.pagination.pageCount ?? 1) > 1 && (
        <div className="pagination">
          <button className="btn btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Prev</button>
          <span>{page} / {data.pagination.pageCount}</span>
          <button
            className="btn btn-sm"
            disabled={page >= (data.pagination.pageCount ?? 1)}
            onClick={() => setPage(page + 1)}
          >Next</button>
        </div>
      )}
      </>
      )}

    </SectionLayout>
  );
}
