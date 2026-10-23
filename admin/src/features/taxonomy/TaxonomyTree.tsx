/**
 * Taxonomy nodes as a folder tree (file-explorer grammar): a chevron tile per branch, no rules between
 * rows, select on click, rename in place (double-click / F2 / pencil), "new folder" rows that only ask
 * for a name — the slug is derived. The server returns nodes sorted by path, so parents precede children.
 */
import { useState, type ReactNode } from "react";
import { IconPencil, IconPlus, IconTrash } from "@tabler/icons-react";
import type { TaxonomyNode } from "../../api/types";
import { slugForNode } from "./slug";

/** Where a new node is being typed: a parent id, or "root" */
export type Draft = { parentId: string | null } | null;

/** In-place name editor — Enter / blur commits a changed, non-empty name; Escape cancels. Shared with the DAM folder tree. */
export function NameInput({ initial, onCommit, onCancel }: { initial: string; onCommit(name: string): void; onCancel(): void }) {
  const [value, setValue] = useState(initial);
  const commit = () => (value.trim() && value.trim() !== initial ? onCommit(value.trim()) : onCancel());
  return (
    <input
      className="tax-name-input" autoFocus value={value}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") onCancel();
      }}
    />
  );
}

export function TaxonomyTree({
  nodes, selectedId, onSelect, draft, setDraft, onCreate, onRename, onDelete,
}: {
  nodes: TaxonomyNode[];
  selectedId: string | null;
  onSelect(id: string | null): void;
  draft: Draft;
  setDraft(d: Draft): void;
  onCreate(parentId: string | null, name: string, slug: string): void;
  onRename(id: string, name: string): void;
  onDelete(node: TaxonomyNode): void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const toggle = (id: string, open?: boolean) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (open ?? next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const childrenOf = (parentId: string | null) => nodes.filter((n) => n.parentId === parentId);
  const draftRow = (parentId: string | null, depth: number) =>
    draft && draft.parentId === parentId ? (
      <div className="tax-row" style={{ paddingLeft: `${0.6 + depth * 2}rem` }}>
        <span className="tax-caret-slot" />
        <NameInput
          initial=""
          onCancel={() => setDraft(null)}
          onCommit={(name) => {
            onCreate(parentId, name, slugForNode(name, childrenOf(parentId).map((n) => n.slug)));
            setDraft(null);
          }}
        />
      </div>
    ) : null;

  const renderLevel = (parentId: string | null, depth: number): ReactNode =>
    childrenOf(parentId).map((n) => {
      const hasKids = nodes.some((c) => c.parentId === n.id);
      const open = !collapsed.has(n.id);
      return (
        <div key={n.id} role="treeitem" aria-expanded={hasKids ? open : undefined} aria-selected={n.id === selectedId}>
          <div
            className={n.id === selectedId ? "tax-row selected" : "tax-row"}
            style={{ paddingLeft: `${0.6 + depth * 2}rem` }}
            tabIndex={0}
            onClick={() => onSelect(n.id)}
            onDoubleClick={() => setRenamingId(n.id)}
            onKeyDown={(e) => {
              if (e.target !== e.currentTarget) return;
              if (e.key === "F2") setRenamingId(n.id);
              if (e.key === "ArrowRight" && hasKids) toggle(n.id, true);
              if (e.key === "ArrowLeft" && hasKids) toggle(n.id, false);
            }}
          >
            {hasKids ? (
              <button
                className={open ? "tax-caret open" : "tax-caret"} aria-label={open ? "Collapse" : "Expand"}
                onClick={(e) => { e.stopPropagation(); toggle(n.id); }}
              >
                <svg width="1rem" height="1rem" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.7">
                  <path d="M4.4 2.4 8 6l-3.6 3.6" />
                </svg>
              </button>
            ) : (
              <span className="tax-caret-slot" />
            )}
            {renamingId === n.id ? (
              <NameInput
                initial={n.name}
                onCancel={() => setRenamingId(null)}
                onCommit={(name) => { onRename(n.id, name); setRenamingId(null); }}
              />
            ) : (
              <span className="tax-name">{n.name}</span>
            )}
            {n.entryComponentUid && renamingId !== n.id && (
              <span className="tax-attr-dot" title={`Entry component: ${n.entryComponentUid}`} />
            )}
            <span className="tax-row-actions" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
              <button className="btn btn-ghost btn-icon" title="New node inside"
                onClick={() => { toggle(n.id, true); setDraft({ parentId: n.id }); }}>
                <IconPlus size="1.3rem" />
              </button>
              <button className="btn btn-ghost btn-icon" title="Rename (F2)" onClick={() => setRenamingId(n.id)}>
                <IconPencil size="1.3rem" />
              </button>
              <button className="btn btn-ghost btn-icon tax-del" title="Delete with everything inside" onClick={() => onDelete(n)}>
                <IconTrash size="1.3rem" />
              </button>
            </span>
          </div>
          {open && renderLevel(n.id, depth + 1)}
          {draftRow(n.id, depth + 1)}
        </div>
      );
    });

  return (
    <div className="tax-tree" role="tree" onClick={() => onSelect(null)}>
      <div onClick={(e) => e.stopPropagation()}>
        {renderLevel(null, 0)}
        {draftRow(null, 0)}
      </div>
      {nodes.length === 0 && !draft && <p className="tax-empty">No nodes yet — add the first one.</p>}
    </div>
  );
}
