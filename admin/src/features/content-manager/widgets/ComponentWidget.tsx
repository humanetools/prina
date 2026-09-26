/** component / dynamic_zone widgets — blocks stack as collapsible cards, new blocks come from a tile picker */
import { useState } from "react";
import { IconCirclePlus } from "@tabler/icons-react";
import { useComponents } from "../../../hooks/queries";
import type { WidgetProps } from "./BasicWidgets";
import { FieldRow } from "./FieldRow";
import { BlockCard, blockSummary } from "./BlockCard";
import { ComponentPicker } from "./ComponentPicker";

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
  if (comp.definition.fields.length === 0) {
    return <p className="widget-hint">This component has no fields yet — add them in the Builder.</p>;
  }
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

/** Per-index open state; a newly added block opens, the rest keep their state */
function useOpenBlocks() {
  const [closed, setClosed] = useState<Set<number>>(new Set());
  const isOpen = (i: number) => !closed.has(i);
  const toggle = (i: number) =>
    setClosed((s) => { const n = new Set(s); if (n.has(i)) n.delete(i); else n.add(i); return n; });
  /** Keep closed flags attached to the right block when the list is reordered / shrunk */
  const remap = (map: (i: number) => number | null) =>
    setClosed((s) => { const n = new Set<number>(); for (const i of s) { const j = map(i); if (j !== null) n.add(j); } return n; });
  return { isOpen, toggle, remap };
}

const swap = <T,>(arr: T[], i: number, j: number) => { const n = [...arr]; [n[i], n[j]] = [n[j]!, n[i]!]; return n; };

export function ComponentWidget({ field, value, onChange }: WidgetProps) {
  const uid = field.component as string;
  const repeatable = field.repeatable === true;
  const { data: components } = useComponents();
  const { isOpen, toggle, remap } = useOpenBlocks();

  if (!repeatable) {
    return <ComponentFields componentUid={uid} value={(value as Obj) ?? {}} onChange={onChange} />;
  }
  const items = (value as Obj[]) ?? [];
  const name = components?.find((c) => c.uid === uid)?.name ?? uid;
  const max = typeof field.max === "number" ? field.max : undefined;
  const set = (next: Obj[]) => onChange(next.length ? next : null);
  return (
    <div className="dz-list">
      {items.map((item, i) => (
        <BlockCard
          key={i}
          title={`${name} #${i + 1}`}
          summary={blockSummary(item)}
          open={isOpen(i)}
          onToggle={() => toggle(i)}
          canMoveUp={i > 0}
          canMoveDown={i < items.length - 1}
          onMoveUp={() => { set(swap(items, i, i - 1)); remap((k) => (k === i ? i - 1 : k === i - 1 ? i : k)); }}
          onMoveDown={() => { set(swap(items, i, i + 1)); remap((k) => (k === i ? i + 1 : k === i + 1 ? i : k)); }}
          onDuplicate={max !== undefined && items.length >= max ? undefined : () => set([...items.slice(0, i + 1), { ...item }, ...items.slice(i + 1)])}
          onRemove={() => { set(items.filter((_, j) => j !== i)); remap((k) => (k === i ? null : k > i ? k - 1 : k)); }}
        >
          <ComponentFields componentUid={uid} value={item} onChange={(v) => set(items.map((x, j) => (j === i ? v : x)))} />
        </BlockCard>
      ))}
      <button
        type="button"
        className="dz-add"
        disabled={max !== undefined && items.length >= max}
        onClick={() => set([...items, {}])}
      >
        <IconCirclePlus size="1.6rem" /> Add {name}
      </button>
    </div>
  );
}

export function DynamicZoneWidget({ field, value, onChange }: WidgetProps) {
  const allowed = (field.components as string[]) ?? [];
  const { data: components } = useComponents();
  const items = (value as Obj[]) ?? [];
  const [picking, setPicking] = useState(false);
  const { isOpen, toggle, remap } = useOpenBlocks();
  const label = (field.label as string | undefined) ?? field.name;
  const max = typeof field.max === "number" ? field.max : undefined;
  const full = max !== undefined && items.length >= max;
  const nameOf = (uid: string) => components?.find((c) => c.uid === uid)?.name ?? uid;
  const set = (next: Obj[]) => onChange(next.length ? next : null);

  return (
    <div className="dz-list">
      {items.map((item, i) => {
        const uid = String(item.__component);
        return (
          <BlockCard
            key={i}
            title={nameOf(uid)}
            summary={blockSummary(item)}
            open={isOpen(i)}
            onToggle={() => toggle(i)}
            canMoveUp={i > 0}
            canMoveDown={i < items.length - 1}
            onMoveUp={() => { set(swap(items, i, i - 1)); remap((k) => (k === i ? i - 1 : k === i - 1 ? i : k)); }}
            onMoveDown={() => { set(swap(items, i, i + 1)); remap((k) => (k === i ? i + 1 : k === i + 1 ? i : k)); }}
            onDuplicate={full ? undefined : () => set([...items.slice(0, i + 1), { ...item }, ...items.slice(i + 1)])}
            onRemove={() => { set(items.filter((_, j) => j !== i)); remap((k) => (k === i ? null : k > i ? k - 1 : k)); }}
          >
            <ComponentFields
              componentUid={uid}
              value={item}
              onChange={(v) => set(items.map((x, j) => (j === i ? { ...v, __component: uid } : x)))}
            />
          </BlockCard>
        );
      })}

      {allowed.length === 0 ? (
        <p className="widget-hint">
          Inactive zone — no components allowed yet. Add them in the Builder (Validation tab).
        </p>
      ) : picking ? (
        <div className="dz-picker-wrap">
          <ComponentPicker
            allowed={allowed}
            components={components}
            onPick={(uid) => { set([...items, { __component: uid }]); setPicking(false); }}
          />
          <button type="button" className="link-btn dz-picker-cancel" onClick={() => setPicking(false)}>Cancel</button>
        </div>
      ) : (
        <button type="button" className="dz-add" disabled={full} onClick={() => setPicking(true)} title={full ? `Maximum ${max} blocks` : undefined}>
          <IconCirclePlus size="1.6rem" /> Add a component to {label}
          {items.length > 0 && <span className="dz-add-count">{items.length}{max !== undefined ? ` / ${max}` : ""}</span>}
        </button>
      )}
    </div>
  );
}
