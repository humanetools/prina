/**
 * Pick the taxonomy nodes an entry (or, from the Media Library, an asset) sits in. Every taxonomy is a section of one scrolling list — no
 * switching — drawn with the Taxonomy page's tree grammar (chevron tile, dot on leaves). Selection is
 * multiple and spans taxonomies; nothing is saved until Apply.
 */
import { useMemo, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { IconSearch } from "@tabler/icons-react";
import { api } from "../../api/client";
import type { TaxonomyNode } from "../../api/types";
import { useComponents, useTaxonomies } from "../../hooks/queries";
import { Modal } from "../../components/common/Modal";

export interface Attachment {
  nodeId: string;
  attributeValues: Record<string, unknown> | null;
}

export function TaxonomyPicker({
  current, onSave, onClose, title = "Classify this entry", attributes = true,
}: {
  current: Attachment[];
  title?: string;
  /** false = hide the attribute-set chips — assets take no attribute values */
  attributes?: boolean;
  onSave(next: Attachment[]): void;
  onClose(): void;
}) {
  const { data: taxonomies } = useTaxonomies();
  const { data: components } = useComponents();
  const trees = useQueries({
    queries: (taxonomies ?? []).map((t) => ({
      queryKey: ["taxonomy-tree", t.uid],
      queryFn: () => api<TaxonomyNode[]>(`/api/taxonomies/${t.uid}/tree`),
    })),
  });
  const [selected, setSelected] = useState<Set<string>>(new Set(current.map((a) => a.nodeId)));
  // Branches start closed (deep or numerous taxonomies stay scannable) — except the ones leading to what the
  // entry already has, so the current classification is visible on open. `toggled` = flipped by the user.
  const [toggled, setToggled] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const flip = (set: Set<string>, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  };
  const componentName = useMemo(() => new Map((components ?? []).map((c) => [c.uid, c.name])), [components]);
  const q = query.trim().toLowerCase();
  const loaded = trees.map((t) => t.data);
  // cheap enough to recompute per render (a few hundred nodes at most); trees arrive one by one
  const openByDefault = new Set<string>();
  const had = new Set(current.map((a) => a.nodeId));
  for (const nodes of loaded) {
    for (const picked of (nodes ?? []).filter((n) => had.has(n.id))) {
      for (const n of nodes ?? []) if (picked.path.startsWith(`${n.path}.`)) openByDefault.add(n.id);
    }
  }
  const isOpen = (id: string) => openByDefault.has(id) !== toggled.has(id);

  return (
    <Modal title={title} onClose={onClose}>
      <div className="taxpick">
        <label className="taxpick-search">
          <IconSearch size="1.5rem" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a node…" autoFocus />
        </label>

        <div className="taxpick-list">
          {(taxonomies ?? []).map((t, i) => {
            const nodes = trees[i]?.data ?? [];
            // searching flattens the tree to the matches; otherwise hide what sits under a collapsed branch
            const hiddenUnder = nodes.filter((n) => !isOpen(n.id)).map((n) => `${n.path}.`);
            const rows = q
              ? nodes.filter((n) => n.name.toLowerCase().includes(q) || n.path.toLowerCase().includes(q))
              : nodes.filter((n) => !hiddenUnder.some((p) => n.path.startsWith(p)));
            const picked = nodes.filter((n) => selected.has(n.id)).length;
            if (q && rows.length === 0) return null;
            return (
              <section key={t.uid} className="taxpick-group">
                <header>
                  <span>{t.name}</span>
                  {picked > 0 && <span className="bulk-count">{picked}</span>}
                </header>
                {rows.map((n) => {
                  const hasKids = nodes.some((c) => c.parentId === n.id);
                  const open = isOpen(n.id);
                  const depth = q ? 0 : n.path.split(".").length - 1;
                  return (
                    <label
                      key={n.id}
                      className={selected.has(n.id) ? "tax-row taxpick-row selected" : "tax-row taxpick-row"}
                      style={{ paddingLeft: `${0.6 + depth * 2}rem` }}
                    >
                      {hasKids && !q ? (
                        <button
                          type="button" className={open ? "tax-caret open" : "tax-caret"} aria-label={open ? "Collapse" : "Expand"}
                          onClick={(e) => { e.preventDefault(); setToggled((s) => flip(s, n.id)); }}
                        >
                          <svg width="1rem" height="1rem" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.7">
                            <path d="M4.4 2.4 8 6l-3.6 3.6" />
                          </svg>
                        </button>
                      ) : (
                        <span className="tax-caret-slot" />
                      )}
                      <input type="checkbox" checked={selected.has(n.id)} onChange={() => setSelected((s) => flip(s, n.id))} />
                      <span className="tax-name">{n.name}</span>
                      {q && <code className="taxpick-path">{n.path.replace(/\./g, " › ")}</code>}
                      {attributes && n.attributeComponentUid && (
                        <span className="chip chip-sm taxpick-attr" title="Classifying here adds these fields to the entry">
                          + {componentName.get(n.attributeComponentUid) ?? n.attributeComponentUid}
                        </span>
                      )}
                    </label>
                  );
                })}
                {nodes.length === 0 && <p className="tax-empty">No nodes in this taxonomy.</p>}
              </section>
            );
          })}
          {(taxonomies ?? []).length === 0 && <p className="tax-empty">No taxonomies yet — create one under Taxonomy.</p>}
          {q && !loaded.some((nodes) => (nodes ?? []).some((n) => n.name.toLowerCase().includes(q) || n.path.toLowerCase().includes(q))) && (
            <p className="tax-empty">Nothing matches “{query.trim()}”.</p>
          )}
        </div>

        <footer className="taxpick-foot">
          <span className="muted">{selected.size} selected</span>
          {selected.size > 0 && <button className="link-btn" onClick={() => setSelected(new Set())}>Clear</button>}
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={onClose}>Cancel</button>
          <button
            className="btn btn-primary"
            onClick={() => {
              const keep = current.filter((a) => selected.has(a.nodeId));
              const added = [...selected]
                .filter((id) => !current.some((a) => a.nodeId === id))
                .map((nodeId) => ({ nodeId, attributeValues: null }));
              onSave([...keep, ...added]);
            }}
          >
            Apply
          </button>
        </footer>
      </div>
    </Modal>
  );
}
