/** One field = label + per-type widget (the unit of the schema-driven form) */
import { Component, useContext, type ReactNode } from "react";
import { FieldType, type FieldDef } from "../../../api/types";
import {
  BooleanWidget,
  DateWidget,
  EnumWidget,
  JsonWidget,
  NumberWidget,
  TextWidget,
  UidWidget,
  type WidgetProps,
} from "./BasicWidgets";
import { MediaWidget } from "./MediaWidget";
import { RichtextWidget } from "./RichtextWidget";
import { RelationWidget } from "./RelationWidget";
import { TaxonomyWidget } from "./TaxonomyWidget";
import { ComponentWidget, DynamicZoneWidget } from "./ComponentWidget";
import { VariantAxisWidget } from "./VariantAxisWidget";
import { EntrySavedAtContext, isAddedSince } from "../SchemaNotices";

const WIDGETS: Record<string, (p: WidgetProps) => JSX.Element | null> = {
  [FieldType.Text]: TextWidget,
  [FieldType.Uid]: UidWidget,
  [FieldType.Number]: NumberWidget,
  [FieldType.Boolean]: BooleanWidget,
  [FieldType.Date]: DateWidget,
  [FieldType.Enum]: EnumWidget,
  [FieldType.Json]: JsonWidget,
  [FieldType.Media]: MediaWidget,
  [FieldType.Richtext]: RichtextWidget,
  [FieldType.Relation]: RelationWidget,
  [FieldType.Taxonomy]: TaxonomyWidget,
  [FieldType.Component]: ComponentWidget,
  [FieldType.DynamicZone]: DynamicZoneWidget,
  [FieldType.VariantAxis]: VariantAxisWidget,
};

/**
 * A widget trusts the shape its field promises. After a schema change the stored value may have another
 * shape (a single id where a list is expected) and the widget throws — without this boundary that blanked
 * the whole admin (56-IMPL). The field shows the value as stored and a way to clear it instead.
 */
class FieldBoundary extends Component<{ shape: string; value: unknown; onClear(): void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidUpdate(prev: { shape: string }) {
    // a new value (cleared, replaced) gets a fresh try
    if (prev.shape !== this.props.shape && this.state.failed) this.setState({ failed: false });
  }
  render() {
    if (!this.state.failed) return this.props.children;
    const raw = JSON.stringify(this.props.value);
    return (
      <div className="field-broken">
        <span>The stored value does not fit this field as it is now defined.</span>
        <code>{raw && raw.length > 160 ? `${raw.slice(0, 157)}…` : raw}</code>
        <button type="button" className="btn btn-sm" onClick={this.props.onClear}>Clear value</button>
      </div>
    );
  }
}

/** Cheap fingerprint of a value's shape — enough to tell "the value changed" for the boundary reset */
const shapeOf = (v: unknown): string => (v === null || v === undefined ? "∅" : Array.isArray(v) ? `[${v.length}]` : typeof v === "object" ? `{${Object.keys(v as object).length}}` : `${typeof v}:${String(v).length}`);

export function FieldRow({
  field,
  value,
  onChange,
  inherited,
  onClearOverride,
  self,
}: {
  field: FieldDef;
  value: unknown;
  onChange(v: unknown): void;
  /** Variant child: inheriting from parent (no override) */
  inherited?: boolean;
  onClearOverride?(): void;
  self?: { id: string; documentId: string | null };
}) {
  const Widget = WIDGETS[field.type];
  // added to the schema after this entry was last saved (56-IMPL)
  const isNew = isAddedSince(field, useContext(EntrySavedAtContext));
  return (
    <div className={`field-row${inherited ? " inherited" : ""}${isNew ? " is-new" : ""}`} data-type={field.type} data-field={field.name}>
      <div className="field-label">
        <span>
          {field.label ?? field.name}
          {field.required && <em className="req">*</em>}
          {isNew && <em className="field-new-tag" title="Added to the schema after this entry was last saved">New</em>}
        </span>
        <span className="field-meta">
          {inherited && <span className="inherit-tag">inherited</span>}
          {!inherited && onClearOverride && (
            <button type="button" className="link-btn" onClick={onClearOverride}>
              Clear override
            </button>
          )}
          <code>{field.type}</code>
        </span>
      </div>
      {Widget ? (
        <FieldBoundary shape={shapeOf(value)} value={value} onClear={() => onChange(null)}>
          <Widget field={field} value={value} onChange={onChange} inherited={inherited} self={self} />
        </FieldBoundary>
      ) : (
        <div className="form-error">Unsupported field type: {field.type}</div>
      )}
      {field.description && <div className="widget-hint">{field.description}</div>}
    </div>
  );
}
