/** Type editor (T3.2) — tabs: Fields / Predicate·schema.org / Templates */
import {useEffect, useState, useMemo } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { IconPlus, IconTrash } from "@tabler/icons-react";
import { api, ApiError } from "../../api/client";
import { FieldType, type ContentType, type FieldDef } from "../../api/types";
import {
  useComponents,
  useContentTypes,
  useEntries,
  useInvalidatingMutation,
} from "../../hooks/queries";
import { FieldTypeTile } from "../../components/common/FieldTypeTile";
import { adminEe } from "../../ee-loader";
import { PresetGallery } from "./PresetGallery";
import { ZonePanel } from "./ZonePanel";
import { SchemaOrgTab } from "./semantic/SchemaOrgTab";
import { SeoTab } from "./seo/SeoTab";
import { TemplateEditor } from "../templates/TemplateEditorPage";
import { AddFieldModal } from "./field-modal/AddFieldModal";
import { FieldEditModal } from "./field-modal/FieldEditModal";
import { DeleteFieldModal } from "./field-modal/DeleteFieldModal";

type Tab = "fields" | "semantic" | "seo" | "templates";

/** Field modal state machine: picker → configure → save, or row click → edit / delete confirm */
type FieldModal =
  | { kind: "none" }
  | { kind: "pick" }
  | { kind: "new"; type: FieldType }
  | { kind: "edit"; field: FieldDef; tab?: "basic" | "validation" | "advanced" }
  | { kind: "delete"; name: string };

export function TypeEditor({ contentType }: { contentType: ContentType }) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [tab, setTab] = useState<Tab>("fields");
  // Land on the right tab when navigating between types via ?tab=semantic (e.g. from the graph canvas)
  useEffect(() => {
    const t = searchParams.get("tab");
    if (t === "fields" || t === "semantic" || t === "seo" || t === "templates") setTab(t);
  }, [searchParams, contentType.uid]);
  const [modal, setModal] = useState<FieldModal>({ kind: "none" });
  const [openZones, setOpenZones] = useState<Set<string>>(new Set());
  const [deleteTypeOpen, setDeleteTypeOpen] = useState(false);
  const [error, setError] = useState<string[] | null>(null);
  const { data: components } = useComponents();
  const { data: types } = useContentTypes();
  const { data: entryPage } = useEntries(contentType.uid, { page: "1", pageSize: "1" });
  const entryTotal = entryPage?.pagination.total ?? 0;

  const deleteType = useInvalidatingMutation(
    () => api(`/api/content-types/${contentType.uid}`, { method: "DELETE" }),
    [["content-types"]],
  );

  const update = useInvalidatingMutation(
    (body: Record<string, unknown>) =>
      api(`/api/content-types/${contentType.uid}`, { method: "PUT", body }),
    [["content-types"]],
  );

  const saveDefinition = (fields: FieldDef[]) => {
    setError(null);
    update.mutate(
      { definition: { ...contentType.definition, fields } },
      {
        onError: (e) => {
          const details = e instanceof ApiError ? (e.details as { issues?: string[] }) : null;
          setError(details?.issues ?? [e instanceof Error ? e.message : "Save failed"]);
        },
      },
    );
  };

  const fields = contentType.definition.fields;

  /** View-only column sort — third click returns to the definition's manual order */
  const [fieldSort, setFieldSort] = useState<{ key: "name" | "type" | "localized"; dir: "asc" | "desc" } | null>(null);
  const cycleFieldSort = (key: "name" | "type" | "localized") =>
    setFieldSort((prev) =>
      prev?.key !== key ? { key, dir: "asc" } : prev.dir === "asc" ? { key, dir: "desc" } : null,
    );
  const viewFields = useMemo(() => {
    if (!fieldSort) return fields;
    const val = (f: FieldDef): string =>
      fieldSort.key === "name" ? (f.label ?? f.name) : fieldSort.key === "type" ? f.type : f.localized ? "1" : "0";
    const dir = fieldSort.dir === "asc" ? 1 : -1;
    return [...fields].sort((a, b) => val(a).localeCompare(val(b)) * dir);
  }, [fields, fieldSort]);
  const sortArrow = (key: string) =>
    fieldSort?.key === key ? (fieldSort.dir === "asc" ? " ▲" : " ▼") : "";

  /** Column resize — px overrides over the default grid template, applied via a CSS var */
  const FT_DEFAULT_COLS = ["3.4rem", "minmax(24rem, 1.2fr)", "10rem", "1fr", "10rem", "4rem"];
  const [ftColPx, setFtColPx] = useState<Record<number, number>>({});
  const ftCols = FT_DEFAULT_COLS.map((d, i) => (ftColPx[i] ? `${ftColPx[i]}px` : d)).join(" ");
  const startFtResize = (e: React.PointerEvent, col: number) => {
    e.preventDefault();
    e.stopPropagation();
    const cell = (e.target as HTMLElement).parentElement;
    if (!cell) return;
    const startX = e.clientX;
    const startWidth = cell.getBoundingClientRect().width;
    const onMove = (ev: PointerEvent) => {
      const w = Math.max(70, startWidth + (ev.clientX - startX));
      setFtColPx((prev) => ({ ...prev, [col]: w }));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const saveField = (def: FieldDef, isNew: boolean) => {
    saveDefinition(
      isNew ? [...fields, def] : fields.map((f) => (f.name === def.name ? def : f)),
    );
  };

  return (
    <>
      <div className="page-head">
        <div>
          <div className="row-gap">
            <h1 className="type-h1">{contentType.name}</h1>
            <span className="chip chip-sm">
              {contentType.kind === "collection" ? "Collection Type" : "Single Type"}
            </span>
          </div>
          <span className="type-sub">
            api::{contentType.uid}.{contentType.uid} · {fields.length} fields · Draft &amp; Publish on
          </span>
        </div>
        <div className="row-gap">
          <button className="btn btn-primary" onClick={() => setModal({ kind: "pick" })}>
            <IconPlus size="1.5rem" /> Add field
          </button>
        </div>
      </div>

      <div className="tabs">
        {([
          ["fields", "Field"],
          ["semantic", "Predicate · schema.org"],
          ["seo", "SEO"],
          ["templates", "Templates"],
        ] as Array<[Tab, string]>).map(([key, label]) => (
          <button key={key} className={tab === key ? "tab active" : "tab"} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </div>

      {error && (
        <div className="form-error"><ul>{error.map((i) => <li key={i}>{i}</li>)}</ul></div>
      )}

      {tab === "fields" && (
        <>
          <div className="field-table" style={{ "--ft-cols": ftCols } as React.CSSProperties}>
            <div className="field-table-head">
              <div />
              <div className="head-sortable ft-h" onClick={() => cycleFieldSort("name")}>
                Field{sortArrow("name")}
                <span className="dt-resizer" onPointerDown={(e) => startFtResize(e, 1)}
                  onClick={(e) => e.stopPropagation()} />
              </div>
              <div className="head-sortable ft-h" onClick={() => cycleFieldSort("type")}>
                Type{sortArrow("type")}
                <span className="dt-resizer" onPointerDown={(e) => startFtResize(e, 2)}
                  onClick={(e) => e.stopPropagation()} />
              </div>
              <div className="ft-h">
                Rules
                <span className="dt-resizer" onPointerDown={(e) => startFtResize(e, 3)}
                  onClick={(e) => e.stopPropagation()} />
              </div>
              <div
                className="head-sortable ft-h"
                title="Separate value per locale — also the default selection for Translate with AI"
                onClick={() => cycleFieldSort("localized")}
              >
                Localizable{sortArrow("localized")}
                <span className="dt-resizer" onPointerDown={(e) => startFtResize(e, 4)}
                  onClick={(e) => e.stopPropagation()} />
              </div>
              <div />
            </div>
            {viewFields.map((f) => (
              <div key={f.name}>
              <div className="field-table-row" onClick={() => setModal({ kind: "edit", field: f })}>
                <span className="field-drag" title="Drag to reorder">
                  <svg width="1rem" height="1.6rem" viewBox="0 0 10 16" fill="currentColor">
                    <circle cx="3" cy="4" r="1.15" /><circle cx="7" cy="4" r="1.15" />
                    <circle cx="3" cy="8" r="1.15" /><circle cx="7" cy="8" r="1.15" />
                    <circle cx="3" cy="12" r="1.15" /><circle cx="7" cy="12" r="1.15" />
                  </svg>
                </span>
                <div className="field-ident">
                  {f.type === FieldType.DynamicZone && (
                    <button
                      className={openZones.has(f.name) ? "zone-caret open" : "zone-caret"}
                      title="Show allowed components"
                      onClick={(e) => {
                        e.stopPropagation();
                        setOpenZones((s) => {
                          const next = new Set(s);
                          if (next.has(f.name)) next.delete(f.name);
                          else next.add(f.name);
                          return next;
                        });
                      }}
                    >
                      <svg width="1.1rem" height="1.1rem" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6">
                        <path d="M4.4 2.4 8 6l-3.6 3.6" />
                      </svg>
                    </button>
                  )}
                  <FieldTypeTile type={f.type} />
                  <span className="field-name">{f.label ?? f.name}</span>
                  <code className="field-key">{f.name}</code>
                </div>
                <div className="field-type-cell"><code>{f.type}</code></div>
                <div className="field-rule">
                  {[
                    f.required && "required",
                    (f as { unique?: boolean }).unique && "unique",
                    f.type === FieldType.Text &&
                      (f as { maxLength?: number }).maxLength !== undefined &&
                      `max ${(f as { maxLength?: number }).maxLength}`,
                    f.type === FieldType.Relation && `→ ${f.target}${f.predicate ? ` · ${f.predicate}` : ""}`,
                    f.type === FieldType.Media && f.multiple && `multiple · min ${f.min ?? 1}`,
                    f.type === FieldType.Enum && `${((f.options as string[]) ?? []).length} options`,
                    f.type === FieldType.DynamicZone &&
                      ((f.components as string[]) ?? []).length > 0 &&
                      `${(f.components as string[]).length} components`,
                    f.type === FieldType.VariantAxis &&
                      ((f.axes as Array<{ name: string }>) ?? []).map((a) => a.name).join(" · "),
                  ].filter(Boolean).join(" · ")}
                  {f.type === FieldType.DynamicZone &&
                    ((f.components as string[]) ?? []).length === 0 && (
                      <span className="rule-warn">inactive — no allowed components</span>
                    )}
                </div>
                <div className="field-localize" onClick={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    className={f.localized ? "switch on" : "switch"}
                    role="switch"
                    aria-checked={f.localized === true}
                    aria-label={`Localizable — ${f.label ?? f.name}`}
                    title="Separate value per locale · default selection for Translate with AI"
                    onClick={() =>
                      saveField(
                        { ...f, localized: f.localized ? undefined : true } as FieldDef,
                        false,
                      )
                    }
                  >
                    <span className="switch-knob" />
                  </button>
                </div>
                <button
                  className="btn btn-ghost btn-icon field-del"
                  title="Delete field"
                  onClick={(e) => {
                    e.stopPropagation();
                    setModal({ kind: "delete", name: f.name });
                  }}
                >
                  <IconTrash size="1.4rem" />
                </button>
              </div>
              {f.type === FieldType.DynamicZone && openZones.has(f.name) && (
                <ZonePanel
                  zoneField={f}
                  onSaveZone={(componentUids) =>
                    saveDefinition(
                      fields.map((x) =>
                        x.name === f.name ? { ...x, components: componentUids } : x,
                      ),
                    )
                  }
                />
              )}
              </div>
            ))}
            {fields.length === 0 && (
              <div className="field-table-row"><span /><span className="muted">No fields.</span></div>
            )}
          </div>
          <div className="row-gap" style={{ marginTop: "var(--space-4)" }}>
            <label className="field-inline">
              <span>Display field</span>
              <select
                value={contentType.definition.displayField ?? ""}
                onChange={(e) =>
                  update.mutate({
                    definition: {
                      ...contentType.definition,
                      displayField: e.target.value || undefined,
                    },
                  })
                }
              >
                <option value="">(None)</option>
                {fields.map((f) => (
                  <option key={f.name} value={f.name}>{f.label ?? f.name}</option>
                ))}
              </select>
            </label>
          </div>
          {/* Edition slot — chatbot knowledge exclusion (renders nothing in OSS) */}
          {adminEe?.ChatbotTypeToggle && (
            <adminEe.ChatbotTypeToggle contentType={contentType} />
          )}
          <PresetGallery />
          <button
            className="btn-danger-outline"
            style={{ marginTop: "var(--space-5)" }}
            onClick={() => setDeleteTypeOpen(true)}
          >
            Delete this type
          </button>
        </>
      )}

      {tab === "semantic" && (
        <SchemaOrgTab contentType={contentType} onSave={(patch) => update.mutate(patch)} />
      )}

      {tab === "seo" && (
        <SeoTab contentType={contentType} onSave={(patch) => update.mutate(patch)} />
      )}

      {tab === "templates" && (
        <>
          <TemplateEditor typeUid={contentType.uid} mode="embedded" />
          <p className="widget-hint" style={{ marginTop: "var(--space-2)" }}>
            Fullscreen lifts the editor over the shell — unsaved edits are kept.{" "}
            <Link to={`/templates/${contentType.uid}`}>Open in its own page</Link> for a
            deep link.
          </p>
        </>
      )}

      {modal.kind === "pick" && (
        <AddFieldModal
          typeName={contentType.name}
          onClose={() => setModal({ kind: "none" })}
          onPick={(type) => setModal({ kind: "new", type })}
        />
      )}

      {(modal.kind === "new" || modal.kind === "edit") && (
        <FieldEditModal
          initial={modal.kind === "edit" ? modal.field : null}
          newType={modal.kind === "new" ? modal.type : undefined}
          initialTab={modal.kind === "edit" ? modal.tab : undefined}
          typeUid={contentType.uid}
          typeFields={fields}
          components={components ?? []}
          typeUids={(types ?? []).map((t) => t.uid)}
          onClose={() => setModal({ kind: "none" })}
          onDelete={
            modal.kind === "edit"
              ? (name) => setModal({ kind: "delete", name })
              : undefined
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

      {deleteTypeOpen && (
        <div className="fm-backdrop" onClick={() => setDeleteTypeOpen(false)}>
          <div
            className="fm-confirm" onClick={(e) => e.stopPropagation()}
            role="alertdialog" aria-label={`Delete ${contentType.name}`}
          >
            <div className="fm-confirm-head">
              <span className="fm-confirm-icon"><IconTrash size="1.5rem" /></span>
              <div className="fm-confirm-title">Delete {contentType.name}?</div>
            </div>
            <div className="fm-confirm-body">
              This removes the type and everything under it —{" "}
              <strong>{entryTotal} entr{entryTotal === 1 ? "y" : "ies"}</strong> in every locale,
              their version history and templates. This cannot be undone.
            </div>
            <div className="fm-confirm-note">
              MCP tools for this type disappear on the agents' next tool refresh.
            </div>
            <div className="fm-confirm-foot">
              <button className="btn" onClick={() => setDeleteTypeOpen(false)}>Cancel</button>
              <button
                className="btn-danger-solid" disabled={deleteType.isPending}
                onClick={() =>
                  deleteType.mutate(undefined, {
                    onSuccess: () => navigate("/ctb"),
                    onError: (e) => {
                      setDeleteTypeOpen(false);
                      setError([e instanceof ApiError ? e.message : "Delete failed"]);
                    },
                  })
                }
              >
                Delete type
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
