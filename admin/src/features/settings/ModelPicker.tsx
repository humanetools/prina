/**
 * Model select fed by the provider's live list (31-IMPL). The list is a convenience, never a gate:
 * "Other…" opens a free-text field, so a model the list does not show (or a list that failed) never
 * blocks the user — the old hard-coded catalog did exactly that.
 */
import { useState } from "react";
import { IconRefresh } from "@tabler/icons-react";
import type { ModelList } from "./useProviderModels";

const OTHER = "\u0000other";

export function ModelPicker({
  value, onChange, list, loading, error, onReload, placeholder, compact,
}: {
  value: string;
  onChange(model: string): void;
  list: ModelList | null;
  loading: boolean;
  error: string | null;
  /** present = a ↻ button that refetches */
  onReload?(): void;
  placeholder?: string;
  /** row variant inside the routing order — no hints, fixed width */
  compact?: boolean;
}) {
  const ids = (list?.models ?? []).map((m) => m.id);
  // typing a model the list does not have keeps the free-text field open
  const [other, setOther] = useState(() => !!value && list !== null && !ids.includes(value));
  const showText = other || (list !== null && list.models.length === 0) || (list === null && !loading && !!error);
  const selectValue = showText ? OTHER : ids.includes(value) ? value : value ? value : ids[0] ?? "";

  return (
    <div className={compact ? "model-picker compact" : "model-picker"}>
      <div className="model-picker-row">
        <select
          aria-label="Model" value={selectValue} disabled={loading}
          onChange={(e) => {
            if (e.target.value === OTHER) { setOther(true); return; }
            setOther(false);
            onChange(e.target.value);
          }}
        >
          {loading && <option value="">Loading models…</option>}
          {!loading && list === null && !error && <option value="">{value || "Enter an API key to load models"}</option>}
          {!loading && value && !ids.includes(value) && !showText && <option value={value}>{value}</option>}
          {list?.models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          <option value={OTHER}>Other…</option>
        </select>
        {onReload && (
          <button type="button" className="btn btn-ghost btn-icon" title="Reload the model list" aria-label="Reload models" disabled={loading} onClick={onReload}>
            <IconRefresh size="1.4rem" />
          </button>
        )}
      </div>
      {showText && (
        <input
          className="model-picker-text" value={value} placeholder={placeholder ?? "model-id"} autoFocus={other}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {!compact && error && <span className="form-error">{error}</span>}
      {!compact && !error && list?.note && <span className="widget-hint">{list.note}</span>}
      {!compact && !error && list?.source === "live" && <span className="widget-hint">{list.models.length} models from the provider.</span>}
    </div>
  );
}
