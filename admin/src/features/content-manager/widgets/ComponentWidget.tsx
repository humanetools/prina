/** component / dynamic_zone widgets — recursively render the component definition (P4) */
import { IconPlus, IconTrash } from "@tabler/icons-react";
import { useComponents } from "../../../hooks/queries";
import type { WidgetProps } from "./BasicWidgets";
import { FieldRow } from "./FieldRow";

type Obj = Record<string, unknown>;

function ComponentFields({
  componentUid,
  value,
  onChange,
}: {
  componentUid: string;
  value: Obj;
  onChange(v: Obj): void;
}) {
  const { data: components } = useComponents();
  const comp = components?.find((c) => c.uid === componentUid);
  if (!comp) return <div className="form-error">component '{componentUid}' not found</div>;
  return (
    <div className="component-fields">
      {comp.definition.fields.map((f) => (
        <FieldRow
          key={f.name}
          field={f}
          value={value[f.name]}
          onChange={(v) => onChange({ ...value, [f.name]: v })}
        />
      ))}
    </div>
  );
}

export function ComponentWidget({ field, value, onChange }: WidgetProps) {
  const uid = field.component as string;
  const repeatable = field.repeatable === true;

  if (!repeatable) {
    return (
      <ComponentFields
        componentUid={uid}
        value={(value as Obj) ?? {}}
        onChange={onChange}
      />
    );
  }
  const items = (value as Obj[]) ?? [];
  return (
    <div className="repeat-list">
      {items.map((item, i) => (
        <div key={i} className="repeat-item">
          <ComponentFields
            componentUid={uid}
            value={item}
            onChange={(v) => onChange(items.map((x, j) => (j === i ? v : x)))}
          />
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => {
              const next = items.filter((_, j) => j !== i);
              onChange(next.length ? next : null);
            }}
          >
            <IconTrash size="1.4rem" />
          </button>
        </div>
      ))}
      <button type="button" className="btn btn-sm" onClick={() => onChange([...items, {}])}>
        <IconPlus size="1.4rem" /> Add item
      </button>
    </div>
  );
}

export function DynamicZoneWidget({ field, value, onChange }: WidgetProps) {
  const allowed = (field.components as string[]) ?? [];
  const { data: components } = useComponents();
  const items = (value as Obj[]) ?? [];

  return (
    <div className="repeat-list">
      {items.map((item, i) => (
        <div key={i} className="repeat-item dz-block">
          <div className="dz-head">
            <code>{String(item.__component)}</code>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                const next = items.filter((_, j) => j !== i);
                onChange(next.length ? next : null);
              }}
            >
              <IconTrash size="1.4rem" />
            </button>
          </div>
          <ComponentFields
            componentUid={String(item.__component)}
            value={item}
            onChange={(v) => onChange(items.map((x, j) => (j === i ? { ...v, __component: item.__component } : x)))}
          />
          {(components?.find((c) => c.uid === item.__component)?.definition.fields.length ?? 0) === 0 && (
            <p className="widget-hint">This component has no fields yet — add them in the Builder.</p>
          )}
        </div>
      ))}
      {allowed.length === 0 ? (
        <p className="widget-hint">
          Inactive zone — no components allowed yet. Add them in the Builder (Validation tab).
        </p>
      ) : (
        <select
          value=""
          onChange={(e) => {
            if (e.target.value) onChange([...items, { __component: e.target.value }]);
          }}
        >
          <option value="">+ Add block…</option>
          {allowed.map((uid) => (
            <option key={uid} value={uid}>
              {components?.find((c) => c.uid === uid)?.name ?? uid}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
