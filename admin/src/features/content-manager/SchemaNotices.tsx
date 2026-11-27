/**
 * Entry edit page — what a schema change means for this entry, besides values that need fixing (56-IMPL):
 *  - RemovedFieldsBox: fields that were removed from the schema but whose values are still stored here.
 *    Nothing is thrown away behind the editor's back — the values are listed and deleted on confirmation.
 *  - NewFieldsBox: fields added to the schema after this entry was last saved, so nobody has filled them in.
 *  - EntrySavedAtContext / isAddedSince: how a field row knows to mark itself "New".
 */
import { createContext } from "react";
import { IconPlus, IconTrash } from "@tabler/icons-react";
import { FieldType, type ComponentDef, type FieldDef } from "../../api/types";

/** When the open entry was last saved (ISO) — null on the create form, where nothing is "new" */
export const EntrySavedAtContext = createContext<string | null>(null);

/** The field joined the schema after the entry's last save */
export function isAddedSince(field: FieldDef, savedAt: string | null): boolean {
  const addedAt = field.addedAt as string | undefined;
  return !!savedAt && !!addedAt && Date.parse(addedAt) > Date.parse(savedAt);
}

const preview = (v: unknown): string => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s === undefined ? "" : s.length > 140 ? `${s.slice(0, 137)}…` : s;
};

export function RemovedFieldsBox({ removed, busy, onConfirm }: { removed: Array<{ path: string; value: unknown }>; busy: boolean; onConfirm(): void }) {
  if (removed.length === 0) return null;
  const many = removed.length > 1;
  return (
    <div className="schema-notice removed" role="status">
      <div className="schema-notice-head">
        <IconTrash size="1.7rem" />
        <div>
          <strong>{many ? `${removed.length} fields were` : "A field was"} removed from the schema</strong>
          <span>
            {many ? "Their values are" : "Its value is"} still stored in this entry but no longer used. Confirm to delete {many ? "them" : "it"} from
            the entry — this cannot be undone here.
          </span>
        </div>
      </div>
      {removed.map((r) => (
        <div key={r.path} className="schema-notice-row">
          <code>{r.path}</code>
          <span>{preview(r.value)}</span>
        </div>
      ))}
      <div className="row-gap" style={{ justifyContent: "flex-end" }}>
        <button type="button" className="btn btn-sm" disabled={busy} onClick={onConfirm}>
          Confirm — delete {many ? "these values" : "this value"}
        </button>
      </div>
    </div>
  );
}

interface NewField { topLevel: string; label: string }

/** Fields added since the entry's last save — top-level ones and those inside the components the entry uses */
export function findNewFields(fields: FieldDef[], components: ComponentDef[], savedAt: string | null): NewField[] {
  if (!savedAt) return [];
  const byUid = new Map(components.map((c) => [c.uid, c]));
  const out: NewField[] = [];
  const walk = (list: FieldDef[], topLevel: string | null, trail: string[], seen: Set<string>) => {
    for (const f of list) {
      const top = topLevel ?? f.name;
      const here = [...trail, f.label ?? f.name];
      if (isAddedSince(f, savedAt)) {
        out.push({ topLevel: top, label: here.join(" › ") });
        continue; // a new container: its inner fields are new by definition — one line is enough
      }
      const inner =
        f.type === FieldType.Component ? [f.component as string] : f.type === FieldType.DynamicZone ? ((f.components as string[] | undefined) ?? []) : [];
      for (const uid of inner) {
        const comp = byUid.get(uid);
        if (!comp || seen.has(uid)) continue;
        walk(comp.definition.fields, top, f.type === FieldType.DynamicZone ? [...here, comp.name] : here, new Set([...seen, uid]));
      }
    }
  };
  walk(fields, null, [], new Set());
  return out;
}

export function NewFieldsBox({ added }: { added: NewField[] }) {
  if (added.length === 0) return null;
  const jump = (name: string) => {
    const row = document.querySelector<HTMLElement>(`.form-fields > [data-field="${CSS.escape(name)}"]`);
    row?.scrollIntoView({ behavior: "smooth", block: "center" });
    row?.querySelector<HTMLElement>("input, textarea, select, [contenteditable=true], button")?.focus({ preventScroll: true });
  };
  return (
    <div className="schema-notice added" role="status">
      <div className="schema-notice-head">
        <IconPlus size="1.7rem" />
        <div>
          <strong>{added.length === 1 ? "A field was" : `${added.length} fields were`} added to the schema</strong>
          <span>
            Added after this entry was last saved, so {added.length === 1 ? "it is" : "they are"} empty here. Fill {added.length === 1 ? "it" : "them"} in
            below — the fields are marked <em className="field-new-tag">New</em>. This note goes away once the entry is saved.
          </span>
        </div>
      </div>
      <div className="chip-row">
        {added.map((a) => (
          <button key={`${a.topLevel}:${a.label}`} type="button" className="chip chip-sm schema-notice-jump" onClick={() => jump(a.topLevel)}>
            {a.label}
          </button>
        ))}
      </div>
    </div>
  );
}
