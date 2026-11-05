/**
 * Define a taxonomy's attribute fields (33-IMPL) — a label, a type, multi-line for text. The key sites
 * read (`attributes.<key>`) is derived from the label once, on first save, and then never changes;
 * editors never type it. Removing a field drops its values from every node, so removal warns.
 */
import { useState } from "react";
import { IconPlus, IconTrash } from "@tabler/icons-react";
import { ApiError } from "../../api/client";
import { TaxonomyAttributeType, type TaxonomyAttributeField } from "../../api/types";
import { Modal } from "../../components/common/Modal";

interface Row { key: string | null; label: string; type: TaxonomyAttributeType; multiline?: boolean }

/** label → snake_case key; non-Latin labels (한글 …) fall back to attr_N */
function deriveKey(label: string, taken: Set<string>): string {
  let base = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^[0-9]/, "a$&").slice(0, 60);
  if (!base) { let n = 1; while (taken.has(`attr_${n}`)) n++; base = `attr_${n}`; }
  let key = base; let n = 2;
  while (taken.has(key)) key = `${base}_${n++}`;
  return key;
}

export function AttributeFieldsModal({ fields, onSave, onClose }: {
  fields: TaxonomyAttributeField[];
  onSave(fields: TaxonomyAttributeField[]): Promise<void>;
  onClose(): void;
}) {
  const [rows, setRows] = useState<Row[]>(fields.map((f) => ({ key: f.name, label: f.label ?? f.name, type: f.type, multiline: f.multiline })));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const removed = fields.filter((f) => !rows.some((r) => r.key === f.name));
  const blank = rows.some((r) => !r.label.trim());
  const update = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, k) => (k === i ? { ...r, ...patch } : r)));

  return (
    <Modal title="Attribute fields" onClose={onClose}>
      <div className="form-fields tax-fields">
        <p className="widget-hint">Every node of this taxonomy gets these fields.</p>
        {rows.map((r, i) => (
          <div key={i} className="tax-field-row">
            <input placeholder="Label — e.g. Description" value={r.label} autoFocus={!r.key && !r.label} onChange={(e) => update(i, { label: e.target.value })} />
            <select value={r.type} onChange={(e) => update(i, { type: e.target.value as TaxonomyAttributeType, ...(e.target.value !== "text" ? { multiline: undefined } : {}) })}>
              <option value={TaxonomyAttributeType.Text}>Text</option>
              <option value={TaxonomyAttributeType.Number}>Number</option>
              <option value={TaxonomyAttributeType.Boolean}>Boolean</option>
            </select>
            <label className="tax-field-multi" title="Multi-line editor">
              <input type="checkbox" disabled={r.type !== TaxonomyAttributeType.Text} checked={!!r.multiline} onChange={(e) => update(i, { multiline: e.target.checked || undefined })} />
              <span>multi-line</span>
            </label>
            <button type="button" className="btn btn-ghost btn-icon tax-del" title="Remove field" onClick={() => setRows((rs) => rs.filter((_, k) => k !== i))}>
              <IconTrash size="1.3rem" />
            </button>
          </div>
        ))}
        <button type="button" className="btn-dashed" onClick={() => setRows((rs) => [...rs, { key: null, label: "", type: TaxonomyAttributeType.Text }])}>
          <IconPlus size="1.4rem" /> Add field
        </button>
        {removed.length > 0 && (
          <div className="tax-attach-note">
            <strong>Removing {removed.map((f) => f.label ?? f.name).join(", ")}</strong>
            <p>Their values disappear from every node of this taxonomy. Sites reading those keys get nothing.</p>
          </div>
        )}
        {error && <div className="form-error">{error}</div>}
        <div style={{ display: "flex", gap: "1rem", justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button
            type="button" className="btn btn-primary" disabled={busy || blank || rows.length === 0 && fields.length === 0}
            onClick={async () => {
              setBusy(true); setError(null);
              try {
                // existing keys stay; new rows get a key from their label, unique within the taxonomy
                const taken = new Set(rows.map((r) => r.key).filter((k): k is string => !!k));
                const out: TaxonomyAttributeField[] = rows.map((r) => {
                  const key = r.key ?? deriveKey(r.label, taken);
                  taken.add(key);
                  return { name: key, type: r.type, label: r.label.trim(), ...(r.multiline ? { multiline: true } : {}) };
                });
                await onSave(out);
                onClose();
              } catch (e) {
                setError(e instanceof ApiError ? e.message : "Save failed");
              } finally {
                setBusy(false);
              }
            }}
          >
            Save fields
          </button>
        </div>
      </div>
    </Modal>
  );
}
