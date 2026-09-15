/** Taxonomy chips + dynamic attribute-set section (P4, §2.8) — attribute groups appear on taxonomy selection */
import { useState } from "react";
import { IconCategory2, IconX } from "@tabler/icons-react";
import { api } from "../../api/client";
import type { EntryDetail } from "../../api/types";
import {
  useComponents,
  useInvalidatingMutation,
  useTaxonomies,
  useTaxonomyTree,
} from "../../hooks/queries";
import { Modal } from "../../components/common/Modal";
import { FieldRow } from "./widgets/FieldRow";

interface Attachment {
  nodeId: string;
  attributeValues: Record<string, unknown> | null;
}

export function TaxonomySection({
  typeUid,
  detail,
}: {
  typeUid: string;
  detail: EntryDetail;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const { data: components } = useComponents();

  const save = useInvalidatingMutation(
    (attachments: Attachment[]) =>
      api(`/api/content/${typeUid}/${detail.entry.id}/taxonomies`, {
        method: "PUT",
        body: { attachments },
      }),
    [["entry", typeUid, detail.entry.id]],
  );

  const current: Attachment[] = detail.taxonomies.map((t) => ({
    nodeId: t.nodeId,
    attributeValues: t.attributeValues,
  }));

  const detach = (nodeId: string) =>
    save.mutate(current.filter((a) => a.nodeId !== nodeId));

  const updateAttributes = (nodeId: string, values: Record<string, unknown>) =>
    save.mutate(
      current.map((a) => (a.nodeId === nodeId ? { ...a, attributeValues: values } : a)),
    );

  return (
    <section className="taxonomy-section">
      <div className="section-head">
        <h3><IconCategory2 size="1.6rem" /> Taxonomy</h3>
        <button className="btn btn-sm" onClick={() => setPickerOpen(true)}>Select taxonomy</button>
      </div>
      <div className="chip-row">
        {detail.taxonomies.map((t) => (
          <span key={t.nodeId} className="chip">
            {t.path.replace(/\./g, " / ")}
            <button onClick={() => detach(t.nodeId)} aria-label="Detach">
              <IconX size="1.2rem" />
            </button>
          </span>
        ))}
        {detail.taxonomies.length === 0 && <span className="muted">No taxonomy</span>}
      </div>

      {/* Attribute sets: field groups of the component linked to the taxonomy appear dynamically */}
      {detail.taxonomies
        .filter((t) => t.attributeComponentUid)
        .map((t) => {
          const comp = components?.find((c) => c.uid === t.attributeComponentUid);
          if (!comp) return null;
          const values = t.attributeValues ?? {};
          return (
            <div key={t.nodeId} className="attribute-set">
              <div className="attribute-set-title">
                {t.name} attributes <code>{comp.uid}</code>
              </div>
              {comp.definition.fields.map((f) => (
                <FieldRow
                  key={f.name}
                  field={f}
                  value={values[f.name]}
                  onChange={(v) => updateAttributes(t.nodeId, { ...values, [f.name]: v })}
                />
              ))}
            </div>
          );
        })}

      {pickerOpen && (
        <TaxonomyPicker
          current={current}
          onSave={(next) => {
            save.mutate(next);
            setPickerOpen(false);
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </section>
  );
}

function TaxonomyPicker({
  current,
  onSave,
  onClose,
}: {
  current: Attachment[];
  onSave(next: Attachment[]): void;
  onClose(): void;
}) {
  const { data: taxonomies } = useTaxonomies();
  const [taxonomyUid, setTaxonomyUid] = useState<string | undefined>(undefined);
  const { data: nodes } = useTaxonomyTree(taxonomyUid ?? taxonomies?.[0]?.uid);
  const [selected, setSelected] = useState<Set<string>>(
    new Set(current.map((a) => a.nodeId)),
  );

  const toggle = (nodeId: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });

  return (
    <Modal title="Select taxonomies (multiple)" onClose={onClose}>
      <select
        value={taxonomyUid ?? taxonomies?.[0]?.uid ?? ""}
        onChange={(e) => setTaxonomyUid(e.target.value)}
      >
        {(taxonomies ?? []).map((t) => (
          <option key={t.uid} value={t.uid}>{t.name}</option>
        ))}
      </select>
      <ul className="tree-list">
        {(nodes ?? []).map((n) => (
          <li key={n.id} style={{ paddingLeft: `${(n.path.split(".").length - 1) * 16}px` }}>
            <label>
              <input
                type="checkbox"
                checked={selected.has(n.id)}
                onChange={() => toggle(n.id)}
              />
              {n.name}
              {n.attributeComponentUid && (
                <code className="muted"> attrs: {n.attributeComponentUid}</code>
              )}
            </label>
          </li>
        ))}
      </ul>
      <button
        className="btn btn-primary btn-block"
        onClick={() => {
          const keep = current.filter((a) => selected.has(a.nodeId));
          const added = [...selected]
            .filter((id) => !current.some((a) => a.nodeId === id))
            .map((nodeId) => ({ nodeId, attributeValues: null }));
          onSave([...keep, ...added]);
        }}
      >
        Apply
      </button>
    </Modal>
  );
}
