/**
 * Taxonomy section of the asset detail panel (23-IMPL) — chips for the nodes the asset sits in, plus the same
 * picker entries use. Assets share the entry taxonomies but take no attribute-set values. Saves immediately.
 */
import { useState } from "react";
import { IconX } from "@tabler/icons-react";
import { api } from "../../api/client";
import type { AssetDetail } from "../../api/types";
import { useInvalidatingMutation } from "../../hooks/queries";
import { TaxonomyPicker } from "../content-manager/TaxonomyPicker";

export function AssetTaxonomy({ asset }: { asset: AssetDetail }) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const save = useInvalidatingMutation(
    (nodeIds: string[]) => api(`/api/assets/${asset.id}/taxonomies`, { method: "PUT", body: { nodeIds } }),
    [["asset", asset.id], ["assets"]],
  );
  const current = asset.taxonomies.map((t) => t.nodeId);

  return (
    <section className="panel-section">
      <div className="asset-tax-head">
        <span className="panel-title">Taxonomy</span>
        <button className="link-btn" onClick={() => setPickerOpen(true)}>Select</button>
      </div>
      <div className="chip-row">
        {asset.taxonomies.map((t) => (
          <span key={t.nodeId} className="chip chip-sm" title={`${t.taxonomy}:${t.path}`}>
            {t.path.replace(/\./g, " / ")}
            <button onClick={() => save.mutate(current.filter((id) => id !== t.nodeId))} aria-label="Detach">
              <IconX size="1.2rem" />
            </button>
          </span>
        ))}
        {asset.taxonomies.length === 0 && <span className="widget-hint">Not classified</span>}
      </div>
      {save.error && <div className="form-error">{save.error.message}</div>}

      {pickerOpen && (
        <TaxonomyPicker
          title="Classify this asset"
          attributes={false}
          current={current.map((nodeId) => ({ nodeId, attributeValues: null }))}
          onSave={(next) => {
            save.mutate(next.map((a) => a.nodeId));
            setPickerOpen(false);
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </section>
  );
}
