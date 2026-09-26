/** relation widget — target-type entry selection chips (+ predicate label, P4) */
import { useMemo } from "react";
import { IconX } from "@tabler/icons-react";
import { useContentTypes, useEntries } from "../../../hooks/queries";
import type { WidgetProps } from "./BasicWidgets";
import { entryLabel } from "../format";

export function RelationWidget({ field, value, onChange, self }: WidgetProps) {
  const target = field.target as string;
  const predicate = field.predicate as string | undefined;
  const toMany = field.relationKind === "oneToMany" || field.relationKind === "manyToMany";
  const { data: types } = useContentTypes();
  const { data: candidates } = useEntries(target, { page: "1", pageSize: "100" });
  const targetType = types?.find((t) => t.uid === target);

  const ids = useMemo<string[]>(
    () => (toMany ? ((value as string[]) ?? []) : value ? [value as string] : []),
    [value, toMany],
  );
  const labelOf = (id: string) => {
    const e = candidates?.items.find((c) => c.id === id);
    return e && targetType ? entryLabel(targetType.definition, e.values, id) : id.slice(0, 8);
  };

  const add = (id: string) => {
    if (!id) return;
    onChange(toMany ? [...new Set([...ids, id])] : id);
  };
  const remove = (id: string) => {
    if (toMany) {
      const next = ids.filter((x) => x !== id);
      onChange(next.length ? next : null);
    } else onChange(null);
  };

  return (
    <div className="relation-widget">
      <div className="chip-row">
        {ids.map((id) => (
          <span key={id} className="chip">
            {predicate && <em className="chip-predicate">{predicate}</em>}
            {labelOf(id)}
            <button type="button" onClick={() => remove(id)} aria-label="Remove">
              <IconX size="1.2rem" />
            </button>
          </span>
        ))}
        {ids.length === 0 && <span className="muted">No links</span>}
      </div>
      <select value="" onChange={(e) => add(e.target.value)}>
        <option value="">
          {targetType ? `${targetType.name}…` : `${target}…`}
        </option>
        {(candidates?.items ?? [])
          .filter((c) => !ids.includes(c.id))
          // self-relation: exclude itself (including locales of the same document) from candidates
          .filter((c) => !self || (c.id !== self.id && c.documentId !== self.documentId))
          .map((c) => (
            <option key={c.id} value={c.id}>
              {targetType ? entryLabel(targetType.definition, c.values, c.id) : c.id.slice(0, 8)}
            </option>
          ))}
      </select>
    </div>
  );
}
