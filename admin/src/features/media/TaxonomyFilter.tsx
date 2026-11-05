/**
 * Media Library left panel — find assets by classification (23-IMPL). One collapsed tree per taxonomy,
 * drawn with the Taxonomy page's tree grammar. Clicking a node filters the grid to everything under it
 * (descendants included); clicking it again clears the filter. The page keeps folder and node mutually exclusive.
 */
import { useState, type ReactNode } from "react";
import type { TaxonomyNode } from "../../api/types";
import { useTaxonomies, useTaxonomyTree } from "../../hooks/queries";

export interface TaxonomyFilterValue {
  /** `<taxonomyUid>:<node.path>` — what `GET /api/assets?taxonomy=` takes */
  spec: string;
  label: string;
}

function Caret({ open, onClick }: { open: boolean; onClick(): void }) {
  return (
    <button
      type="button" className={open ? "tax-caret open" : "tax-caret"} aria-label={open ? "Collapse" : "Expand"}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
    >
      <svg width="1rem" height="1rem" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.7">
        <path d="M4.4 2.4 8 6l-3.6 3.6" />
      </svg>
    </button>
  );
}

function FilterTree({
  uid, value, onChange,
}: {
  uid: string;
  value: TaxonomyFilterValue | null;
  onChange(next: TaxonomyFilterValue | null): void;
}) {
  const { data: nodes } = useTaxonomyTree(uid);
  // branches start closed — a deep taxonomy must not push the rest of the panel away
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setOpened((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const renderLevel = (parentId: string | null, depth: number): ReactNode =>
    (nodes ?? []).filter((n) => n.parentId === parentId).map((n: TaxonomyNode) => {
      const hasKids = (nodes ?? []).some((c) => c.parentId === n.id);
      const spec = `${uid}:${n.path}`;
      const active = value?.spec === spec;
      return (
        <div key={n.id} role="treeitem" aria-expanded={hasKids ? opened.has(n.id) : undefined} aria-selected={active}>
          <div
            className={active ? "tax-row media-tax-row selected" : "tax-row media-tax-row"}
            style={{ paddingLeft: `${0.4 + depth * 1.6}rem` }}
            tabIndex={0}
            onClick={() => onChange(active ? null : { spec, label: n.name })}
            onKeyDown={(e) => {
              if (e.target !== e.currentTarget) return;
              if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onChange(active ? null : { spec, label: n.name }); }
            }}
          >
            {hasKids ? <Caret open={opened.has(n.id)} onClick={() => toggle(n.id)} /> : <span className="tax-caret-slot" />}
            <span className="tax-name">{n.name}</span>
          </div>
          {hasKids && opened.has(n.id) && renderLevel(n.id, depth + 1)}
        </div>
      );
    });

  if (nodes && nodes.length === 0) return <p className="widget-hint media-tax-empty">No nodes</p>;
  return <div role="tree">{renderLevel(null, 0)}</div>;
}

export function TaxonomyFilter({
  value, onChange,
}: {
  value: TaxonomyFilterValue | null;
  onChange(next: TaxonomyFilterValue | null): void;
}) {
  const { data: taxonomies } = useTaxonomies();
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (uid: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid);
      else next.add(uid);
      return next;
    });
  if (!taxonomies || taxonomies.length === 0) return null;

  return (
    <div className="nav-group">
      <div className="nav-group-title">Taxonomy</div>
      {taxonomies.map((t) => {
        const isOpen = open.has(t.uid);
        const holdsFilter = value?.spec.startsWith(`${t.uid}:`) ?? false;
        return (
          <div key={t.uid}>
            <div className="tax-row media-tax-row media-tax-head" onClick={() => toggle(t.uid)}>
              <Caret open={isOpen} onClick={() => toggle(t.uid)} />
              <span className="tax-name">{t.name}</span>
              {holdsFilter && !isOpen && <span className="chip chip-sm">{value!.label}</span>}
            </div>
            {isOpen && <FilterTree uid={t.uid} value={value} onChange={onChange} />}
          </div>
        );
      })}
    </div>
  );
}
