/**
 * taxonomy widget (44-IMPL) — pick node(s) of one taxonomy. Same chip + select grammar as the relation
 * widget; the select lists the whole tree, indented by depth, so a menu block can point at "Main › MV".
 */
import { useMemo } from "react";
import { IconX } from "@tabler/icons-react";
import { useTaxonomies, useTaxonomyTree } from "../../../hooks/queries";
import type { WidgetProps } from "./BasicWidgets";

export function TaxonomyWidget({ field, value, onChange }: WidgetProps) {
  const taxonomyUid = field.taxonomy as string;
  const multiple = field.multiple === true;
  const { data: taxonomies } = useTaxonomies();
  const { data: nodes } = useTaxonomyTree(taxonomyUid);
  const taxonomy = taxonomies?.find((t) => t.uid === taxonomyUid);

  const ids = useMemo<string[]>(
    () => (multiple ? ((value as string[]) ?? []) : value ? [value as string] : []),
    [value, multiple],
  );
  const byId = useMemo(() => new Map((nodes ?? []).map((n) => [n.id, n])), [nodes]);
  const labelOf = (id: string) => {
    const n = byId.get(id);
    return n ? n.path.replace(/\./g, " › ") : id.slice(0, 8);
  };

  const add = (id: string) => {
    if (!id) return;
    onChange(multiple ? [...new Set([...ids, id])] : id);
  };
  const remove = (id: string) => {
    if (multiple) {
      const next = ids.filter((x) => x !== id);
      onChange(next.length ? next : null);
    } else onChange(null);
  };

  return (
    <div className="relation-widget taxonomy-widget">
      <div className="chip-row">
        {ids.map((id) => (
          <span key={id} className="chip" title={byId.get(id)?.name}>
            {labelOf(id)}
            <button type="button" onClick={() => remove(id)} aria-label="Remove">
              <IconX size="1.2rem" />
            </button>
          </span>
        ))}
        {ids.length === 0 && <span className="muted">No node</span>}
      </div>
      <select value="" onChange={(e) => add(e.target.value)}>
        <option value="">{taxonomy ? `${taxonomy.name}…` : `${taxonomyUid}…`}</option>
        {(nodes ?? [])
          .filter((n) => !ids.includes(n.id))
          .map((n) => {
            const depth = n.path.split(".").length - 1;
            return (
              <option key={n.id} value={n.id}>
                {`${"  ".repeat(depth)}${depth ? "└ " : ""}${n.name}`}
              </option>
            );
          })}
      </select>
    </div>
  );
}
