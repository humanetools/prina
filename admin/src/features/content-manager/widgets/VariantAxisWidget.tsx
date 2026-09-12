/** variant_axis widget (§2.8) — check options per axis → child SKUs derived on save */
import type { WidgetProps } from "./BasicWidgets";

interface Axis {
  name: string;
  options: string[];
}

export function VariantAxisWidget({ field, value, onChange }: WidgetProps) {
  const axes = (field.axes as Axis[]) ?? [];
  const selection = (value as Record<string, string[]>) ?? {};

  const toggle = (axis: string, option: string) => {
    const current = selection[axis] ?? [];
    const next = current.includes(option)
      ? current.filter((o) => o !== option)
      : [...current, option];
    const merged = { ...selection, [axis]: next };
    if (next.length === 0) delete merged[axis];
    onChange(Object.keys(merged).length ? merged : null);
  };

  const comboCount = axes.reduce(
    (acc, a) => acc * Math.max(1, (selection[a.name] ?? []).length || 0),
    axes.some((a) => (selection[a.name] ?? []).length > 0) ? 1 : 0,
  );

  return (
    <div className="variant-axis">
      {axes.map((axis) => (
        <div key={axis.name} className="axis-row">
          <span className="axis-name">{axis.name}</span>
          <div className="chip-row">
            {axis.options.map((opt) => {
              const on = (selection[axis.name] ?? []).includes(opt);
              return (
                <button
                  key={opt}
                  type="button"
                  className={on ? "chip chip-toggle on" : "chip chip-toggle"}
                  onClick={() => toggle(axis.name, opt)}
                >
                  {opt}
                </button>
              );
            })}
          </div>
        </div>
      ))}
      <div className="widget-hint">
        On save, {comboCount} child SKUs are derived and synced from the selected combinations.
      </div>
    </div>
  );
}
