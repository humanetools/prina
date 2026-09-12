/** Primitive type widgets: text/number/boolean/date/enum/json/media (schema-driven form, P4) */
import { useState } from "react";
import type { FieldDef } from "../../../api/types";

export interface WidgetProps {
  field: FieldDef;
  value: unknown;
  onChange(value: unknown): void;
  /** For displaying values a variant child inherits */
  inherited?: boolean;
  /** Entry being edited (to exclude itself from self-relation candidates) */
  self?: { id: string; documentId: string | null };
}

export function TextWidget({ field, value, onChange }: WidgetProps) {
  const v = (value as string) ?? "";
  return field.multiline ? (
    <textarea rows={4} value={v} onChange={(e) => onChange(e.target.value || null)} />
  ) : (
    <input value={v} onChange={(e) => onChange(e.target.value || null)} />
  );
}

export function UidWidget({ field, value, onChange }: WidgetProps) {
  const v = (value as string) ?? "";
  const source = field.targetField as string | undefined;
  return (
    <>
      <input
        value={v} className="mono"
        placeholder={source ? `Auto-generated from '${source}' when left empty` : "my-page"}
        onChange={(e) => onChange(e.target.value || null)}
      />
      <p className="widget-hint">Unique — lowercase letters, digits, - and _ only.</p>
    </>
  );
}

export function NumberWidget({ value, onChange }: WidgetProps) {
  return (
    <input
      type="number"
      value={value === null || value === undefined ? "" : String(value)}
      onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
    />
  );
}

export function BooleanWidget({ value, onChange }: WidgetProps) {
  return (
    <div className="bool-row">
      <div className="bool-seg" role="radiogroup">
        <button
          type="button" role="radio" aria-checked={value === false}
          className={value === false ? "on false" : ""}
          onClick={() => onChange(false)}
        >
          FALSE
        </button>
        <button
          type="button" role="radio" aria-checked={value === true}
          className={value === true ? "on true" : ""}
          onClick={() => onChange(true)}
        >
          TRUE
        </button>
      </div>
      {value !== null && value !== undefined && (
        <button type="button" className="link-btn" onClick={() => onChange(null)}>
          Clear
        </button>
      )}
    </div>
  );
}

export function DateWidget({ field, value, onChange }: WidgetProps) {
  return (
    <input
      type={field.withTime ? "datetime-local" : "date"}
      value={(value as string) ?? ""}
      onChange={(e) => onChange(e.target.value || null)}
    />
  );
}

export function EnumWidget({ field, value, onChange }: WidgetProps) {
  const options = (field.options as string[]) ?? [];
  return (
    <select value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">Select…</option>
      {options.map((o) => (
        <option key={o} value={o}>{o}</option>
      ))}
    </select>
  );
}

export function JsonWidget({ value, onChange }: WidgetProps) {
  const [invalid, setInvalid] = useState(false);
  return (
    <>
      <textarea
        className={invalid ? "code-area json-area invalid" : "code-area json-area"}
        spellCheck={false}
        defaultValue={value === null || value === undefined ? "" : JSON.stringify(value, null, 2)}
        onBlur={(e) => {
          const text = e.target.value.trim();
          if (!text) { setInvalid(false); return onChange(null); }
          try {
            onChange(JSON.parse(text));
            setInvalid(false);
          } catch {
            setInvalid(true); // Value not applied — previous value kept until fixed
          }
        }}
      />
      {invalid && <p className="widget-hint" style={{ color: "var(--danger)" }}>Invalid JSON — the value is not applied until fixed.</p>}
    </>
  );
}

