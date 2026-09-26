/**
 * Right-hand panel of the taxonomy page — the selected node in three tabs (33-IMPL):
 * Node (name · slug · path) · Attribute (the node's own values for the taxonomy's fields, plus the
 * field definitions) · Entry component (the component entries under this node fill in — "attribute set" before).
 */
import { useEffect, useState } from "react";
import { IconAdjustments } from "@tabler/icons-react";
import { TaxonomyAttributeType, type ComponentDef, type TaxonomyAttributeField, type TaxonomyNode } from "../../api/types";
import { AttributeFieldsModal } from "./AttributeFieldsModal";
import { AttributeArt, EmptyHero } from "../../components/common/EmptyHero";

export interface NodePatch { name?: string; slug?: string; entryComponentUid?: string | null; attributes?: Record<string, unknown> }
type Tab = "node" | "attribute" | "component";
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function NodeDetail({
  node, taxonomyUid, attributeFields, components, onSave, onSaveFields, saving,
}: {
  node: TaxonomyNode | null;
  taxonomyUid: string;
  attributeFields: TaxonomyAttributeField[];
  components: ComponentDef[];
  onSave(id: string, patch: NodePatch): void;
  onSaveFields(fields: TaxonomyAttributeField[]): Promise<void>;
  saving: boolean;
}) {
  const [tab, setTab] = useState<Tab>("node");
  const [fieldsOpen, setFieldsOpen] = useState(false);
  const [name, setName] = useState(node?.name ?? "");
  const [slug, setSlug] = useState(node?.slug ?? "");
  useEffect(() => setName(node?.name ?? ""), [node?.id, node?.name]);
  useEffect(() => setSlug(node?.slug ?? ""), [node?.id, node?.slug]);

  const tabs = (
    <div className="tabs tax-tabs" role="tablist">
      {([["node", "Node"], ["attribute", "Attribute"], ["component", "Entry component"]] as const).map(([key, label]) => (
        <button key={key} type="button" role="tab" aria-selected={tab === key} className={tab === key ? "tab active" : "tab"} onClick={() => setTab(key)}>
          {label}
          {key === "attribute" && attributeFields.length > 0 && <span className="tab-count">{attributeFields.length}</span>}
        </button>
      ))}
    </div>
  );

  if (!node) {
    return (
      <section className="tax-detail">
        {tabs}
        {tab === "attribute" ? (
          <AttributeFieldsSummary fields={attributeFields} onEdit={() => setFieldsOpen(true)} />
        ) : (
          <p className="widget-hint">
            Select a node to edit it. Double-click a name (or press F2) to rename in place.
          </p>
        )}
        {fieldsOpen && <AttributeFieldsModal fields={attributeFields} onSave={onSaveFields} onClose={() => setFieldsOpen(false)} />}
      </section>
    );
  }

  const comp = node.entryComponentUid ? components.find((c) => c.uid === node.entryComponentUid) : undefined;
  const commitName = () => {
    const next = name.trim();
    if (next && next !== node.name) onSave(node.id, { name: next });
    else setName(node.name);
  };
  const slugOk = SLUG_RE.test(slug);
  const commitSlug = () => {
    if (slugOk && slug !== node.slug) onSave(node.id, { slug });
    else if (!slugOk) setSlug(node.slug);
  };

  return (
    <section className="tax-detail">
      {tabs}
      {tab === "node" && (
        <div className="form-fields">
          <label className="field"><span>Name</span>
            <input
              value={name} disabled={saving}
              onChange={(e) => setName(e.target.value)}
              onBlur={commitName}
              onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
            />
          </label>
          <label className="field"><span>Slug</span>
            <input
              value={slug} disabled={saving} spellCheck={false} className="tax-slug-input"
              onChange={(e) => setSlug(e.target.value.toLowerCase())}
              onBlur={commitSlug}
              onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
            />
            <p className={slugOk ? "widget-hint" : "widget-hint danger"}>
              {slugOk
                ? "This node's own segment of the path. Filled in from the name — change it for a readable one."
                : "Lowercase letters, digits, - and _ (must start with a letter or digit)."}
            </p>
          </label>
          <div className="field"><span>Path</span>
            <code className="tax-path-box">{node.path}</code>
            <p className="widget-hint">
              Parent slugs + this slug, joined by dots — changes when a slug on the way changes. Sites filter with{" "}
              <code className="tax-path">?taxonomy={taxonomyUid}:{node.path}</code>
            </p>
          </div>
        </div>
      )}

      {tab === "attribute" && (
        <>
          {attributeFields.length === 0 ? (
            <AttributeFieldsSummary fields={attributeFields} onEdit={() => setFieldsOpen(true)} />
          ) : (
            <div className="form-fields">
              {attributeFields.map((f) => (
                <AttributeInput
                  key={f.name} field={f} value={node.attributes[f.name]} disabled={saving}
                  onCommit={(v) => {
                    const next = { ...node.attributes };
                    if (v === null || v === "") delete next[f.name];
                    else next[f.name] = v;
                    onSave(node.id, { attributes: next });
                  }}
                />
              ))}
              <button type="button" className="btn btn-outline btn-block" onClick={() => setFieldsOpen(true)}><IconAdjustments size="1.4rem" /> Edit fields</button>
            </div>
          )}
        </>
      )}

      {tab === "component" && (
        <div className="form-fields">
          <label className="field"><span>Entry component (optional)</span>
            <select
              value={node.entryComponentUid ?? ""} disabled={saving}
              onChange={(e) => onSave(node.id, { entryComponentUid: e.target.value || null })}
            >
              <option value="">None</option>
              {components.map((c) => <option key={c.uid} value={c.uid}>{c.name} ({c.uid})</option>)}
            </select>
            <p className="widget-hint">
              A component whose fields appear on entries classified here — e.g. wattage and port only on chargers. Each entry fills in its own values.
            </p>
          </label>
          {comp && (
            <div style={{ display: "flex", flexDirection: "column", gap: "0.7rem" }}>
              {comp.definition.fields.map((f) => (
                <div key={f.name} className="tax-attr-row"><span>{f.label ?? f.name}</span><code>{f.type}</code></div>
              ))}
            </div>
          )}
        </div>
      )}

      {fieldsOpen && <AttributeFieldsModal fields={attributeFields} onSave={onSaveFields} onClose={() => setFieldsOpen(false)} />}
    </section>
  );
}

function AttributeFieldsSummary({ fields, onEdit }: { fields: TaxonomyAttributeField[]; onEdit(): void }) {
  if (fields.length === 0) {
    // same grammar as the Builder / Content Manager empty states
    return (
      <EmptyHero
        art={<AttributeArt />}
        title="Describe your nodes"
        copy="Attributes are facts about a node itself — a description, an ERP code, a “featured” flag. Every node of this taxonomy gets the same fields."
        actions={<button type="button" className="btn btn-primary" onClick={onEdit}><IconAdjustments size="1.5rem" /> Add fields</button>}
      />
    );
  }
  // fields exist but no node is selected — values live on nodes, so point at the tree
  return (
    <div className="form-fields">
      <div className="tax-attach-note">
        <strong>Select a node to fill in its values</strong>
        <p>Every node of this taxonomy has these {fields.length} attribute{fields.length === 1 ? "" : "s"}. Click a node in the tree and the inputs appear here.</p>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: "0.7rem" }}>
        {fields.map((f) => (
          <div key={f.name} className="tax-attr-row"><span>{f.label ?? f.name}</span><code>{f.type}</code></div>
        ))}
      </div>
      <button type="button" className="btn btn-outline btn-block" onClick={onEdit}><IconAdjustments size="1.4rem" /> Edit fields</button>
    </div>
  );
}

/** One attribute of the node — commits on blur / Enter (text, number) or on change (boolean) */
function AttributeInput({ field, value, disabled, onCommit }: {
  field: TaxonomyAttributeField;
  value: unknown;
  disabled: boolean;
  onCommit(v: string | number | boolean | null): void;
}) {
  const [draft, setDraft] = useState(value === undefined || value === null ? "" : String(value));
  useEffect(() => setDraft(value === undefined || value === null ? "" : String(value)), [value]);
  // the box flips at once; the saved value catches up on refetch
  const [checked, setChecked] = useState(value === true);
  useEffect(() => setChecked(value === true), [value]);
  const label = field.label ?? field.name;
  if (field.type === TaxonomyAttributeType.Boolean) {
    return (
      <label className="check tax-attr-bool">
        <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => { setChecked(e.target.checked); onCommit(e.target.checked ? true : null); }} />
        <span>{label}</span>
      </label>
    );
  }
  const commit = () => {
    if (field.type === TaxonomyAttributeType.Number) {
      if (draft.trim() === "") { if (value !== undefined) onCommit(null); return; }
      const n = Number(draft);
      if (!Number.isFinite(n)) { setDraft(value === undefined ? "" : String(value)); return; }
      if (n !== value) onCommit(n);
      return;
    }
    if (draft !== (value ?? "")) onCommit(draft);
  };
  return (
    <label className="field"><span>{label}</span>
      {field.multiline ? (
        <textarea rows={4} value={draft} disabled={disabled} onChange={(e) => setDraft(e.target.value)} onBlur={commit} />
      ) : (
        <input
          value={draft} disabled={disabled} inputMode={field.type === TaxonomyAttributeType.Number ? "decimal" : undefined}
          onChange={(e) => setDraft(e.target.value)} onBlur={commit}
          onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
        />
      )}
    </label>
  );
}
