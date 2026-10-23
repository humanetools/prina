/** Content-type Builder (P5, T3.2) — type list, creation, edit entry */
import { useEffect, useRef, useState } from "react";
import { NavLink, useNavigate, useParams } from "react-router-dom";
import { IconArrowsSort, IconPencil, IconPlus, IconSortAscendingLetters, IconSortDescendingLetters } from "@tabler/icons-react";
import { api } from "../../api/client";
import { type ContentType, ContentTypeKind } from "../../api/types";
import { useComponents, useContentTypes, useInvalidatingMutation } from "../../hooks/queries";
import { SectionLayout } from "../../layout/SectionLayout";
import { TypeFolderGroup, typeDragProps } from "../content-manager/TypeFolderGroup";
import { TypeKindIcon } from "../../components/common/TypeKindIcon";
import { EmptyHero, TypeCardArt } from "../../components/common/EmptyHero";
import { TypeEditor } from "./TypeEditor";
import { PresetGallery } from "./PresetGallery";
import { CreateTypeModal } from "./CreateTypeModal";
import { CreateComponentModal } from "./CreateComponentModal";
import { ComponentEditor } from "./ComponentEditor";

/**
 * One type in the list — hover shows a pencil, click swaps the label for an input (rename in
 * place; user 2026-09-08). Enter/blur saves the display name through PUT, Esc cancels; the
 * uid and the link never change.
 */
function TypeNavItem({ type, count, indent }: { type: ContentType; count: number; indent?: string }) {
  const { uid, kind, name } = type;
  const style = indent ? { paddingLeft: indent } : undefined;
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);
  const rename = useInvalidatingMutation(
    (next: string) => api(`/api/content-types/${uid}`, { method: "PUT", body: { name: next } }),
    [["content-types"]],
  );
  useEffect(() => { if (!editing) setValue(name); }, [name, editing]);
  useEffect(() => { if (editing) { inputRef.current?.focus(); inputRef.current?.select(); } }, [editing]);
  const commit = async () => {
    const next = value.trim();
    setEditing(false);
    if (!next || next === name) { setValue(name); return; }
    try { await rename.mutateAsync(next); } catch { setValue(name); }
  };
  if (editing) {
    return (
      <div className="nav-item nav-item-editing" style={style}>
        <TypeKindIcon kind={kind} />
        <input ref={inputRef} className="nav-rename" value={value} aria-label={`Rename ${name}`}
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); void commit(); }
            if (e.key === "Escape") { setValue(name); setEditing(false); }
          }} />
      </div>
    );
  }
  return (
    <NavLink to={`/ctb/${uid}`} className={({ isActive }) => (isActive ? "nav-item nav-renamable active" : "nav-item nav-renamable")}
      style={style} {...typeDragProps(type)}>
      <TypeKindIcon kind={kind} />
      <span className="nav-label">{name}</span>
      <button type="button" className="nav-edit" title="Rename" aria-label={`Rename ${name}`}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setEditing(true); }}>
        <IconPencil size="1.3rem" />
      </button>
      <span className="nav-count">{count}</span>
    </NavLink>
  );
}

/** Per-group name sort: none (server order) → A→Z → Z→A, remembered per group */
type NavSort = "none" | "asc" | "desc";
const NEXT_SORT: Record<NavSort, NavSort> = { none: "asc", asc: "desc", desc: "none" };
function useNavSort(group: string): [NavSort, () => void] {
  const key = `prina.ctb.sort.${group}`;
  const [sort, setSort] = useState<NavSort>(() => {
    try { const v = localStorage.getItem(key); return v === "asc" || v === "desc" ? v : "none"; } catch { return "none"; }
  });
  const cycle = () => setSort((s) => {
    const n = NEXT_SORT[s];
    try { localStorage.setItem(key, n); } catch { /* private mode */ }
    return n;
  });
  return [sort, cycle];
}
function sortByName<T extends { name: string }>(items: T[], sort: NavSort): T[] {
  if (sort === "none") return items;
  const dir = sort === "asc" ? 1 : -1;
  return [...items].sort((a, b) => dir * a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }));
}
function NavSortButton({ label, sort, onCycle }: { label: string; sort: NavSort; onCycle(): void }) {
  const title = sort === "none" ? "Sort A→Z" : sort === "asc" ? "Sort Z→A" : "Original order";
  return (
    <button className={`nav-sort${sort === "none" ? "" : " active"}`} title={title} aria-label={`${label}: ${title}`} onClick={onCycle}>
      {sort === "none" ? <IconArrowsSort size="1.2rem" /> : sort === "asc" ? <IconSortAscendingLetters size="1.2rem" /> : <IconSortDescendingLetters size="1.2rem" />}
    </button>
  );
}
function NavGroupTitle({ label, sort, onCycle }: { label: string; sort: NavSort; onCycle(): void }) {
  return (
    <div className="nav-group-title nav-group-title-sortable">
      <span>{label}</span>
      <NavSortButton label={label} sort={sort} onCycle={onCycle} />
    </div>
  );
}

/** CTB context panel — design spec: name + field count, 3 groups: Collection/Components/Single; types sit in folders (38-IMPL) */
function CtbNav({ onNewComponent, activeUid }: { onNewComponent(): void; activeUid?: string }) {
  const { data: types } = useContentTypes();
  const { data: components } = useComponents();
  const [collSort, cycleColl] = useNavSort("collections");
  const [compSort, cycleComp] = useNavSort("components");
  const [singleSort, cycleSingle] = useNavSort("singles");
  const collections = sortByName((types ?? []).filter((t) => t.kind === "collection"), collSort);
  const singles = sortByName((types ?? []).filter((t) => t.kind === "single"), singleSort);
  const comps = sortByName(components ?? [], compSort);

  const typeRow = (t: ContentType, indent: string | undefined) =>
    <TypeNavItem key={t.uid} type={t} count={t.definition.fields.length} indent={indent} />;

  return (
    <>
      <TypeFolderGroup
        kind={ContentTypeKind.Collection} title="Collection Types" types={collections} renderType={typeRow} activeUid={activeUid}
        titleExtra={<NavSortButton label="Collection Types" sort={collSort} onCycle={cycleColl} />}
      />
      <div className="nav-group">
        <NavGroupTitle label="Components" sort={compSort} onCycle={cycleComp} />
        {comps.map((c) => (
          <NavLink key={c.uid} to={`/ctb/component/${c.uid}`}
            className={({ isActive }) => (isActive ? "nav-item active" : "nav-item")}>
            <span className="nav-label">{c.name}</span>
            <span className="nav-count">{c.definition.fields.length}</span>
          </NavLink>
        ))}
        <button className="nav-item nav-new" onClick={onNewComponent}>
          <IconPlus size="1.3rem" /> New component
        </button>
      </div>
      <TypeFolderGroup
        kind={ContentTypeKind.Single} title="Single Types" types={singles} renderType={typeRow} activeUid={activeUid}
        titleExtra={<NavSortButton label="Single Types" sort={singleSort} onCycle={cycleSingle} />}
      />
    </>
  );
}

export function CtbPage() {
  const { uid, cuid } = useParams<{ uid: string; cuid: string }>();
  const [newComponentOpen, setNewComponentOpen] = useState(false);
  const navigate = useNavigate();
  const { data: types } = useContentTypes();
  const [createOpen, setCreateOpen] = useState(false);

  const { data: componentsForEdit } = useComponents();
  const selected = types?.find((t) => t.uid === uid);
  const selectedComponent = componentsForEdit?.find((c) => c.uid === cuid);

  return (
    <SectionLayout
      panelTitle="Content-type Builder"
      panel={<CtbNav onNewComponent={() => setNewComponentOpen(true)} activeUid={uid} />}
      panelAction={
        <div className="context-panel-action">
          <button className="nav-cta" style={{ width: "100%", margin: "0" }} onClick={() => setCreateOpen(true)}>
            <IconPlus size="1.3rem" /> Create new type
          </button>
        </div>
      }
    >
      {/* key by uid: the editors hold per-type state (open modal, expanded zones, sort, errors, the
          template editor's sources/preview entry). Switching types in the sidebar must remount them —
          otherwise the DOM keeps the previous type's state under the new type (hand-off-01 §1). */}
      {selectedComponent ? (
        <ComponentEditor key={selectedComponent.uid} component={selectedComponent} />
      ) : selected ? (
        <TypeEditor key={selected.uid} contentType={selected} />
      ) : (
        <>
          <div className="page-head">
            <h1>Content-type Builder</h1>
          </div>
          <EmptyHero
            art={<TypeCardArt />}
            title="Model your content"
            copy="Pick a type on the left to edit — or create a new one from scratch, ask the AI assistant (top bar) to draft it, or install a preset from the gallery below."
            actions={
              <>
                <button className="btn btn-primary" onClick={() => setCreateOpen(true)}>
                  <IconPlus size="1.5rem" /> New type
                </button>
              </>
            }
          />
          <PresetGallery />
        </>
      )}

      {newComponentOpen && (
        <CreateComponentModal
          onClose={() => setNewComponentOpen(false)}
          onCreated={(newUid) => {
            setNewComponentOpen(false);
            navigate(`/ctb/component/${newUid}`);
          }}
        />
      )}

      {createOpen && (
        <CreateTypeModal
          onClose={() => setCreateOpen(false)}
          onCreated={(newUid) => {
            setCreateOpen(false);
            navigate(`/ctb/${newUid}`);
          }}
        />
      )}
    </SectionLayout>
  );
}
