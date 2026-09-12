/** Content-type Builder (P5, T3.2) — type list, creation, edit entry */
import { useEffect, useRef, useState } from "react";
import { NavLink, useNavigate, useParams } from "react-router-dom";
import { IconPencil, IconPlus } from "@tabler/icons-react";
import { api } from "../../api/client";
import { useComponents, useContentTypes, useInvalidatingMutation } from "../../hooks/queries";
import { SectionLayout } from "../../layout/SectionLayout";
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
function TypeNavItem({ uid, name, count }: { uid: string; name: string; count: number }) {
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
      <div className="nav-item nav-item-editing">
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
    <NavLink to={`/ctb/${uid}`} className={({ isActive }) => (isActive ? "nav-item nav-renamable active" : "nav-item nav-renamable")}>
      <span className="nav-label">{name}</span>
      <button type="button" className="nav-edit" title="Rename" aria-label={`Rename ${name}`}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setEditing(true); }}>
        <IconPencil size="1.3rem" />
      </button>
      <span className="nav-count">{count}</span>
    </NavLink>
  );
}

/** CTB context panel — design spec: name + field count, 3 groups: Collection/Components/Single */
function CtbNav({ onNewComponent }: { onNewComponent(): void }) {
  const { data: types } = useContentTypes();
  const { data: components } = useComponents();
  const collections = (types ?? []).filter((t) => t.kind === "collection");
  const singles = (types ?? []).filter((t) => t.kind === "single");

  const typeItems = (items: typeof collections) =>
    items.map((t) => <TypeNavItem key={t.uid} uid={t.uid} name={t.name} count={t.definition.fields.length} />);

  return (
    <>
      <div className="nav-group">
        <div className="nav-group-title">Collection Types</div>
        {collections.length === 0 && <div className="nav-empty">None</div>}
        {typeItems(collections)}
      </div>
      <div className="nav-group">
        <div className="nav-group-title">Components</div>
        {(components ?? []).map((c) => (
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
      <div className="nav-group">
        <div className="nav-group-title">Single Types</div>
        {singles.length === 0 && <div className="nav-empty">None</div>}
        {typeItems(singles)}
      </div>
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
      panel={<CtbNav onNewComponent={() => setNewComponentOpen(true)} />}
      panelAction={
        <div className="context-panel-action">
          <button className="nav-cta" style={{ width: "100%", margin: "0" }} onClick={() => setCreateOpen(true)}>
            <IconPlus size="1.3rem" /> Create new type
          </button>
        </div>
      }
    >
      {selectedComponent ? (
        <ComponentEditor component={selectedComponent} />
      ) : selected ? (
        <TypeEditor contentType={selected} />
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
