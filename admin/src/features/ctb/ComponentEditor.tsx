/**
 * Component editor — Field tab (composition; non-nestable types excluded from the picker) and the
 * Markup tab (40-IMPL): a switch that makes the component a render unit, then the partial editor.
 */
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { IconPlus, IconTrash } from "@tabler/icons-react";
import { api, ApiError } from "../../api/client";
import { FieldType, type ComponentDef, type FieldDef } from "../../api/types";
import { useContentTypes, useInvalidatingMutation } from "../../hooks/queries";
import { FieldTypeTile } from "../../components/common/FieldTypeTile";
import { GripIcon } from "../../components/common/GripIcon";
import { useRowReorder } from "../../hooks/useRowReorder";
import { AddFieldModal } from "./field-modal/AddFieldModal";
import { FieldEditModal } from "./field-modal/FieldEditModal";
import { DeleteFieldModal } from "./field-modal/DeleteFieldModal";
import { ComponentMarkupEditor } from "../templates/ComponentMarkupEditor";
import { ComponentFolderSelect } from "./ComponentFolderSelect";

type Tab = "fields" | "markup";

const fieldKey = (f: FieldDef) => f.name;
const NESTING_EXCLUDED = [FieldType.Component, FieldType.DynamicZone, FieldType.VariantAxis];

type FieldModal =
  | { kind: "none" }
  | { kind: "pick" }
  | { kind: "new"; type: FieldType }
  | { kind: "edit"; field: FieldDef }
  | { kind: "delete"; name: string };

export function ComponentEditor({ component }: { component: ComponentDef }) {
  const navigate = useNavigate();
  const [modal, setModal] = useState<FieldModal>({ kind: "none" });
  const [tab, setTab] = useState<Tab>("fields");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [markupOffConfirm, setMarkupOffConfirm] = useState(false);
  const [error, setError] = useState<string[] | null>(null);
  const { data: types } = useContentTypes();

  const update = useInvalidatingMutation(
    (body: Record<string, unknown>) =>
      api(`/api/components/${component.uid}`, { method: "PUT", body }),
    [["components"], ["content-types"], ["component-folder-tree"]],
  );
  const remove = useInvalidatingMutation(
    () => api(`/api/components/${component.uid}`, { method: "DELETE" }),
    [["components"], ["content-types"], ["component-folder-tree"]],
  );

  const fields = component.definition.fields;

  const saveDefinition = (next: FieldDef[]) => {
    setError(null);
    update.mutate(
      { definition: { ...component.definition, fields: next } },
      {
        onError: (e) => {
          const details = e instanceof ApiError ? (e.details as { issues?: string[] }) : null;
          setError(details?.issues ?? [e instanceof Error ? e.message : "Save failed"]);
        },
      },
    );
  };

  const reorder = useRowReorder({ items: fields, keyOf: fieldKey, onReorder: saveDefinition });

  const saveField = (def: FieldDef, isNew: boolean) => {
    saveDefinition(isNew ? [...fields, def] : fields.map((f) => (f.name === def.name ? def : f)));
  };

  const markupOn = component.markupEnabled;
  const setMarkup = (on: boolean) => {
    setError(null);
    update.mutate(
      { options: { markup: on } },
      { onError: (e) => setError([e instanceof ApiError ? e.message : "Save failed"]) },
    );
  };

  return (
    <>
      <div className="page-head">
        <div>
          <div className="row-gap">
            <h1 className="type-h1">{component.name}</h1>
            <span className="chip chip-sm">Component</span>
            {/* navigation folder (42-IMPL) — saves on change through the same PUT */}
            <ComponentFolderSelect
              className="type-folder-select"
              value={component.folder ?? "/"}
              disabled={update.isPending}
              onChange={(folder) => {
                setError(null);
                update.mutate({ folder }, { onError: (e) => setError([e instanceof ApiError ? e.message : "Move failed"]) });
              }}
            />
          </div>
          <span className="type-sub">
            {component.uid} · {fields.length} fields · reused inside types
          </span>
        </div>
        <div className="row-gap">
          {tab === "fields" && (
            <button className="btn btn-primary" onClick={() => setModal({ kind: "pick" })}>
              <IconPlus size="1.5rem" /> Add field
            </button>
          )}
        </div>
      </div>

      <div className="tabs">
        {([["fields", "Field"], ["markup", "Markup"]] as Array<[Tab, string]>).map(([key, label]) => (
          <button key={key} className={tab === key ? "tab active" : "tab"} onClick={() => setTab(key)}>
            {label}
            {key === "markup" && markupOn && <span className="dot-mark" aria-label="on" />}
          </button>
        ))}
      </div>

      {error && (
        <div className="form-error"><ul>{error.map((i) => <li key={i}>{i}</li>)}</ul></div>
      )}

      {tab === "markup" && (
        <>
          <div className="markup-switch-row">
            <button
              className={markupOn ? "switch on" : "switch"}
              role="switch"
              aria-checked={markupOn}
              aria-label="Markup for this component"
              disabled={update.isPending}
              onClick={() => (markupOn && component.markup ? setMarkupOffConfirm(true) : setMarkup(!markupOn))}
            >
              <span className="switch-knob" />
            </button>
            <div>
              <div className="markup-switch-title">Markup for this component</div>
              <div className="markup-switch-hint">
                On, the component is a render unit: it carries partial.liquid · style.css · script.js, and page
                templates draw its blocks with <code>{`{% render blk.__component with blk as blk %}`}</code>.
                Off, the sources stay saved but no page can render them.
              </div>
            </div>
            {component.markup && (
              <span className="chip chip-sm" style={{ marginLeft: "auto" }}>
                v{component.markup.version}{component.markup.hasCss ? " · css" : ""}{component.markup.hasJs ? " · js" : ""}
              </span>
            )}
          </div>
          {markupOn ? (
            <ComponentMarkupEditor key={component.uid} component={component} />
          ) : (
            <p className="widget-hint" style={{ marginTop: "var(--space-3)" }}>
              Turn the switch on to edit this component's markup. Pages that already use it in a dynamic zone keep
              working from their own template until the component renders itself.
            </p>
          )}
        </>
      )}

      {markupOffConfirm && (
        <div className="fm-backdrop" onClick={() => setMarkupOffConfirm(false)}>
          <div className="fm-confirm" onClick={(e) => e.stopPropagation()} role="alertdialog" aria-label="Turn markup off">
            <div className="fm-confirm-head">
              <div className="fm-confirm-title">Turn markup off for {component.name}?</div>
            </div>
            <div className="fm-confirm-body">
              Saved versions are kept, but every page template that renders <strong>{component.uid}</strong> fails
              until the switch is on again.
            </div>
            <div className="fm-confirm-foot">
              <button className="btn" onClick={() => setMarkupOffConfirm(false)}>Cancel</button>
              <button className="btn-danger-solid" onClick={() => { setMarkupOffConfirm(false); setMarkup(false); }}>
                Turn off
              </button>
            </div>
          </div>
        </div>
      )}

      {tab === "fields" && (
      <div className="field-table">
        <div className="field-table-head">
          <div />
          <div>Field</div>
          <div>Rules</div>
          <div />
        </div>
        {reorder.items.map((f) => (
          <div
            key={f.name} {...reorder.rowProps(f.name)}
            className={`field-table-row ${reorder.rowProps(f.name).className}`}
            onClick={() => setModal({ kind: "edit", field: f })}
          >
            <span className="field-drag" title="Drag to reorder" {...reorder.handleProps(f.name)}><GripIcon /></span>
            <div className="field-ident">
              <FieldTypeTile type={f.type} />
              <span className="field-name">{f.label ?? f.name}</span>
              <code className="field-key">{f.name}</code>
            </div>
            <div className="field-rule">
              {[
                f.required && "required",
                f.localized && "localized",
                f.type === FieldType.Relation && `→ ${f.target}`,
                f.type === FieldType.Enum && `${((f.options as string[]) ?? []).length} options`,
              ].filter(Boolean).join(" · ")}
            </div>
            <button
              className="btn btn-ghost btn-icon field-del" title="Delete field"
              onClick={(e) => {
                e.stopPropagation();
                setModal({ kind: "delete", name: f.name });
              }}
            >
              <IconTrash size="1.4rem" />
            </button>
          </div>
        ))}
        {fields.length === 0 && (
          <div className="field-table-row"><span /><span className="muted">No fields.</span></div>
        )}
      </div>
      )}

      {tab === "fields" && (
      <button
        className="btn-danger-outline" style={{ marginTop: "var(--space-5)" }}
        onClick={() => setDeleteOpen(true)}
      >
        Delete this component
      </button>
      )}

      {modal.kind === "pick" && (
        <AddFieldModal
          typeName={component.name}
          excludeTypes={NESTING_EXCLUDED}
          onClose={() => setModal({ kind: "none" })}
          onPick={(type) => setModal({ kind: "new", type })}
        />
      )}

      {(modal.kind === "new" || modal.kind === "edit") && (
        <FieldEditModal
          initial={modal.kind === "edit" ? modal.field : null}
          newType={modal.kind === "new" ? modal.type : undefined}
          typeUid={component.uid}
          typeFields={fields}
          components={[]}
          typeUids={(types ?? []).map((t) => t.uid)}
          onClose={() => setModal({ kind: "none" })}
          onDelete={
            modal.kind === "edit" ? (name) => setModal({ kind: "delete", name }) : undefined
          }
          onSave={(def) => {
            saveField(def, modal.kind === "new");
            setModal({ kind: "none" });
          }}
          onAddAnother={(def) => {
            saveField(def, modal.kind === "new");
            setModal({ kind: "pick" });
          }}
        />
      )}

      {modal.kind === "delete" && (
        <DeleteFieldModal
          fieldName={modal.name}
          onCancel={() => setModal({ kind: "none" })}
          onConfirm={() => {
            saveDefinition(fields.filter((x) => x.name !== modal.name));
            setModal({ kind: "none" });
          }}
        />
      )}

      {deleteOpen && (
        <div className="fm-backdrop" onClick={() => setDeleteOpen(false)}>
          <div
            className="fm-confirm" onClick={(e) => e.stopPropagation()}
            role="alertdialog" aria-label={`Delete ${component.name}`}
          >
            <div className="fm-confirm-head">
              <span className="fm-confirm-icon"><IconTrash size="1.5rem" /></span>
              <div className="fm-confirm-title">Delete {component.name}?</div>
            </div>
            <div className="fm-confirm-body">
              Types using this component will fail to validate until their fields are
              updated. Its markup (the partial named {component.uid}) is kept. This cannot be undone.
            </div>
            <div className="fm-confirm-foot">
              <button className="btn" onClick={() => setDeleteOpen(false)}>Cancel</button>
              <button
                className="btn-danger-solid" disabled={remove.isPending}
                onClick={() =>
                  remove.mutate(undefined, {
                    onSuccess: () => navigate("/ctb"),
                    onError: (e) => {
                      setDeleteOpen(false);
                      setError([e instanceof ApiError ? e.message : "Delete failed"]);
                    },
                  })
                }
              >
                Delete component
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
