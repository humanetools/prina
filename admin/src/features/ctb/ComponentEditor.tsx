/** Component editor — field composition. Non-nestable types (component, dynamic_zone, variant_axis) excluded from the picker */
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { IconPlus, IconTrash } from "@tabler/icons-react";
import { api, ApiError } from "../../api/client";
import { FieldType, type ComponentDef, type FieldDef } from "../../api/types";
import { useContentTypes, useInvalidatingMutation } from "../../hooks/queries";
import { FieldTypeTile } from "../../components/common/FieldTypeTile";
import { AddFieldModal } from "./field-modal/AddFieldModal";
import { FieldEditModal } from "./field-modal/FieldEditModal";
import { DeleteFieldModal } from "./field-modal/DeleteFieldModal";

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
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [error, setError] = useState<string[] | null>(null);
  const { data: types } = useContentTypes();

  const update = useInvalidatingMutation(
    (body: Record<string, unknown>) =>
      api(`/api/components/${component.uid}`, { method: "PUT", body }),
    [["components"], ["content-types"]],
  );
  const remove = useInvalidatingMutation(
    () => api(`/api/components/${component.uid}`, { method: "DELETE" }),
    [["components"], ["content-types"]],
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

  const saveField = (def: FieldDef, isNew: boolean) => {
    saveDefinition(isNew ? [...fields, def] : fields.map((f) => (f.name === def.name ? def : f)));
  };

  return (
    <>
      <div className="page-head">
        <div>
          <div className="row-gap">
            <h1 className="type-h1">{component.name}</h1>
            <span className="chip chip-sm">Component</span>
          </div>
          <span className="type-sub">
            {component.uid} · {fields.length} fields · reused inside types
          </span>
        </div>
        <div className="row-gap">
          <button className="btn btn-primary" onClick={() => setModal({ kind: "pick" })}>
            <IconPlus size="1.5rem" /> Add field
          </button>
        </div>
      </div>

      {error && (
        <div className="form-error"><ul>{error.map((i) => <li key={i}>{i}</li>)}</ul></div>
      )}

      <div className="field-table">
        <div className="field-table-head">
          <div />
          <div>Field</div>
          <div>Rules</div>
          <div />
        </div>
        {fields.map((f) => (
          <div key={f.name} className="field-table-row" onClick={() => setModal({ kind: "edit", field: f })}>
            <span />
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

      <button
        className="btn-danger-outline" style={{ marginTop: "var(--space-5)" }}
        onClick={() => setDeleteOpen(true)}
      >
        Delete this component
      </button>

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
              updated. This cannot be undone.
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
