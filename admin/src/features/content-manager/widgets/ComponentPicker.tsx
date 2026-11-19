/** "Pick one component" panel for a dynamic zone — tiles grouped by uid category (`sections.hero` → Sections) */
import { useState } from "react";
import { IconChevronDown } from "@tabler/icons-react";
import type { ComponentDef } from "../../../api/types";
import { FieldTypeTile } from "../../../components/common/FieldTypeTile";

const categoryOf = (uid: string) => (uid.includes(".") ? uid.slice(0, uid.indexOf(".")) : "components");
const titleCase = (s: string) => s.replace(/[-_]/g, " ").replace(/^\w/, (c) => c.toUpperCase());

export function ComponentPicker({
  allowed,
  components,
  onPick,
}: {
  allowed: string[];
  components: ComponentDef[] | undefined;
  onPick(uid: string): void;
}) {
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const defs = allowed.map((uid) => components?.find((c) => c.uid === uid) ?? { uid, name: uid, definition: { fields: [] } });
  const groups = new Map<string, typeof defs>();
  for (const d of defs) {
    const cat = categoryOf(d.uid);
    groups.set(cat, [...(groups.get(cat) ?? []), d]);
  }
  const toggle = (cat: string) =>
    setClosed((s) => { const n = new Set(s); if (n.has(cat)) n.delete(cat); else n.add(cat); return n; });

  return (
    <div className="dz-picker" role="dialog" aria-label="Pick one component">
      <div className="dz-picker-title">Pick one component</div>
      {[...groups.entries()].map(([cat, list]) => {
        const open = !closed.has(cat);
        return (
          <div key={cat} className={open ? "dz-cat open" : "dz-cat"}>
            <button type="button" className="dz-cat-head" onClick={() => toggle(cat)} aria-expanded={open}>
              <span className="dz-caret"><IconChevronDown size="1.3rem" /></span>
              <b>{titleCase(cat)}</b>
              <span className="dz-cat-count">{list.length}</span>
            </button>
            {open && (
              <div className="dz-tiles">
                {list.map((d) => (
                  <button key={d.uid} type="button" className="dz-tile" onClick={() => onPick(d.uid)} title={d.uid}>
                    <FieldTypeTile type="component" />
                    <span className="dz-tile-name">{d.name}</span>
                    <span className="dz-tile-meta">{d.definition.fields.length} field{d.definition.fields.length === 1 ? "" : "s"}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
