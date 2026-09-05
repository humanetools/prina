/** Content-type Builder (P5, T3.2) — type list, creation, edit entry */
import { useState } from "react";
import { NavLink, useNavigate, useParams } from "react-router-dom";
import { IconPlus } from "@tabler/icons-react";
import { useComponents, useContentTypes } from "../../hooks/queries";
import { SectionLayout } from "../../layout/SectionLayout";
import { EmptyHero, TypeCardArt } from "../../components/common/EmptyHero";
import { TypeEditor } from "./TypeEditor";
import { PresetGallery } from "./PresetGallery";
import { CreateTypeModal } from "./CreateTypeModal";
import { CreateComponentModal } from "./CreateComponentModal";
import { ComponentEditor } from "./ComponentEditor";

/** CTB context panel — design spec: name + field count, 3 groups: Collection/Components/Single */
function CtbNav({ onNewComponent }: { onNewComponent(): void }) {
  const { data: types } = useContentTypes();
  const { data: components } = useComponents();
  const collections = (types ?? []).filter((t) => t.kind === "collection");
  const singles = (types ?? []).filter((t) => t.kind === "single");

  const typeItems = (items: typeof collections) =>
    items.map((t) => (
      <NavLink key={t.uid} to={`/ctb/${t.uid}`}
        className={({ isActive }) => (isActive ? "nav-item active" : "nav-item")}>
        <span className="nav-label">{t.name}</span>
        <span className="nav-count">{t.definition.fields.length}</span>
      </NavLink>
    ));

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
