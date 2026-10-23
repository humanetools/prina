/**
 * dynamic zone inline expansion (design 618~688) — shows allowed component cards
 * and their fields inside the field table; handles component field add/remove and zone composition changes.
 */
import { useState } from "react";
import { IconPlus, IconTrash, IconX } from "@tabler/icons-react";
import { api, ApiError } from "../../api/client";
import { FieldType, type ComponentDef, type FieldDef } from "../../api/types";
import { useComponents, useContentTypes, useInvalidatingMutation } from "../../hooks/queries";
import { FieldTypeTile } from "../../components/common/FieldTypeTile";
import { TYPE_LABEL } from "./field-modal/meta";
import { AddFieldModal } from "./field-modal/AddFieldModal";
import { FieldEditModal } from "./field-modal/FieldEditModal";
import { DeleteFieldModal } from "./field-modal/DeleteFieldModal";
import { CreateComponentModal } from "./CreateComponentModal";

const NESTING_EXCLUDED = [FieldType.Component, FieldType.DynamicZone, FieldType.VariantAxis];

/** Field modal state inside a component card — also carries which component is being edited */
type ZoneModal =
  | { kind: "none" }
  | { kind: "pick"; comp: ComponentDef }
  | { kind: "new"; comp: ComponentDef; type: FieldType }
  | { kind: "edit"; comp: ComponentDef; field: FieldDef }
  | { kind: "delete"; comp: ComponentDef; name: string };

export function ZonePanel({
  zoneField,
  onSaveZone,
}: {
  zoneField: FieldDef;
  /** Change the zone's allowed component uid list (saves the type definition) */
  onSaveZone(componentUids: string[]): void;
}) {
  const allowed = (zoneField.components as string[]) ?? [];
  const max = zoneField.max as number | undefined;
  const { data: components } = useComponents();
  const { data: types } = useContentTypes();
  const [modal, setModal] = useState<ZoneModal>({ kind: "none" });
  const [addOpen, setAddOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const updateComponent = useInvalidatingMutation(
    ({ uid, body }: { uid: string; body: Record<string, unknown> }) =>
      api(`/api/components/${uid}`, { method: "PUT", body }),
    [["components"], ["content-types"]],
  );

  const saveComponentFields = (comp: ComponentDef, next: FieldDef[]) => {
    setError(null);
    updateComponent.mutate(
      { uid: comp.uid, body: { definition: { ...comp.definition, fields: next } } },
      { onError: (e) => setError(e instanceof ApiError ? e.message : "Save failed") },
    );
  };

  const cards = allowed
    .map((uid) => components?.find((c) => c.uid === uid))
    .filter((c): c is ComponentDef => !!c);
  const addable = (components ?? []).filter((c) => !allowed.includes(c.uid));

  return (
    <div className="zone-panel">
      <div className="zone-head">
        <span className="zone-head-label">Blocks editors can stack here</span>
        <span className="zone-head-line" />
        <span className="zone-head-meta">
          {allowed.length} component{allowed.length === 1 ? "" : "s"}
          {max ? ` · max ${max} blocks per entry` : ""}
        </span>
      </div>
      {error && <div className="form-error">{error}</div>}
      <div className="zone-grid">
        {cards.map((comp) => (
          <div key={comp.uid} className="zone-card">
            <div className="zone-card-head">
              <FieldTypeTile type={FieldType.Component} />
              <span className="zone-card-title">
                <b>{comp.name}</b>
                <em>{comp.definition.fields.length} fields · {comp.uid}</em>
              </span>
              <button
                className="zone-card-remove" title="Remove from zone"
                onClick={() => onSaveZone(allowed.filter((u) => u !== comp.uid))}
              >
                <IconX size="1.1rem" />
              </button>
            </div>
            <div>
              {comp.definition.fields.map((cf) => (
                <div
                  key={cf.name} className="zone-field-row"
                  onClick={() => setModal({ kind: "edit", comp, field: cf })}
                >
                  <FieldTypeTile type={cf.type} />
                  <span className="zone-field-name">{cf.label ?? cf.name}</span>
                  <span className="zone-field-type">{TYPE_LABEL[cf.type] ?? cf.type}</span>
                  <span style={{ flex: 1 }} />
                  <button
                    className="btn btn-ghost btn-icon field-del" title="Delete field"
                    onClick={(e) => {
                      e.stopPropagation();
                      setModal({ kind: "delete", comp, name: cf.name });
                    }}
                  >
                    <IconTrash size="1.4rem" />
                  </button>
                </div>
              ))}
            </div>
            <button className="zone-add-field" onClick={() => setModal({ kind: "pick", comp })}>
              + Field
            </button>
          </div>
        ))}
        <button className="zone-add-component" onClick={() => setAddOpen(true)}>
          <span className="zone-add-plus">+</span>
          <span className="zone-add-label">Add component</span>
          <span className="zone-add-hint">reuse an existing one or create</span>
        </button>
      </div>

      {modal.kind === "pick" && (
        <AddFieldModal
          typeName={modal.comp.name}
          excludeTypes={NESTING_EXCLUDED}
          onClose={() => setModal({ kind: "none" })}
          onPick={(type) => setModal({ kind: "new", comp: modal.comp, type })}
        />
      )}

      {(modal.kind === "new" || modal.kind === "edit") && (
        <FieldEditModal
          initial={modal.kind === "edit" ? modal.field : null}
          newType={modal.kind === "new" ? modal.type : undefined}
          typeUid={modal.comp.uid}
          typeFields={modal.comp.definition.fields}
          components={[]}
          typeUids={(types ?? []).map((t) => t.uid)}
          onClose={() => setModal({ kind: "none" })}
          onDelete={
            modal.kind === "edit"
              ? (name) => setModal({ kind: "delete", comp: modal.comp, name })
              : undefined
          }
          onSave={(def) => {
            const fields = modal.comp.definition.fields;
            saveComponentFields(
              modal.comp,
              modal.kind === "new" ? [...fields, def] : fields.map((f) => (f.name === def.name ? def : f)),
            );
            setModal({ kind: "none" });
          }}
          onAddAnother={(def) => {
            const fields = modal.comp.definition.fields;
            saveComponentFields(
              modal.comp,
              modal.kind === "new" ? [...fields, def] : fields.map((f) => (f.name === def.name ? def : f)),
            );
            setModal({ kind: "pick", comp: modal.comp });
          }}
        />
      )}

      {modal.kind === "delete" && (
        <DeleteFieldModal
          fieldName={modal.name}
          onCancel={() => setModal({ kind: "none" })}
          onConfirm={() => {
            saveComponentFields(
              modal.comp,
              modal.comp.definition.fields.filter((f) => f.name !== modal.name),
            );
            setModal({ kind: "none" });
          }}
        />
      )}

      {addOpen && (
        <div className="fm-backdrop" onClick={() => setAddOpen(false)}>
          <div className="fm fm-narrow" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Add component">
            <div className="fm-head">
              <div style={{ flex: 1 }}>
                <div className="fm-title">Add a component to {zoneField.name}</div>
                <div className="fm-sub">Reuse an existing component or create a new one.</div>
              </div>
              <button className="fm-close" onClick={() => setAddOpen(false)} aria-label="Close">
                <IconX size="1.3rem" />
              </button>
            </div>
            <div className="fm-body-plain">
              {addable.map((c) => (
                <button
                  key={c.uid} className="opt-card"
                  onClick={() => {
                    onSaveZone([...allowed, c.uid]);
                    setAddOpen(false);
                  }}
                >
                  <FieldTypeTile type={FieldType.Component} />
                  <span className="opt-card-text">
                    <span className="opt-card-name">{c.name}</span>
                    <span className="opt-card-desc">{c.definition.fields.length} fields · {c.uid}</span>
                  </span>
                </button>
              ))}
              {addable.length === 0 && (
                <div className="fm-info">Every existing component is already in this zone.</div>
              )}
              <button
                className="btn" style={{ alignSelf: "flex-start" }}
                onClick={() => { setAddOpen(false); setCreateOpen(true); }}
              >
                <IconPlus size="1.4rem" /> Create a new component
              </button>
            </div>
          </div>
        </div>
      )}

      {createOpen && (
        <CreateComponentModal
          onClose={() => setCreateOpen(false)}
          onCreated={(uid) => {
            setCreateOpen(false);
            onSaveZone([...allowed, uid]);
          }}
        />
      )}
    </div>
  );
}
