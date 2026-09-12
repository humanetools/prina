/** One field = label + per-type widget (the unit of the schema-driven form) */
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
import { ComponentWidget, DynamicZoneWidget } from "./ComponentWidget";
import { VariantAxisWidget } from "./VariantAxisWidget";

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
  [FieldType.Component]: ComponentWidget,
  [FieldType.DynamicZone]: DynamicZoneWidget,
  [FieldType.VariantAxis]: VariantAxisWidget,
};

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
  return (
    <div className={inherited ? "field-row inherited" : "field-row"}>
      <div className="field-label">
        <span>
          {field.label ?? field.name}
          {field.required && <em className="req">*</em>}
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
        <Widget field={field} value={value} onChange={onChange} inherited={inherited} self={self} />
      ) : (
        <div className="form-error">Unsupported field type: {field.type}</div>
      )}
      {field.description && <div className="widget-hint">{field.description}</div>}
    </div>
  );
}
