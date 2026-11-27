/**
 * Entry edit page — "Needs fixing" (56-IMPL). After a schema change an entry may hold values the field no
 * longer accepts. Nothing was converted: this box names each one and offers the two honest fixes — clear
 * the value, or, where the field merely went from one to many, keep the value as a one-item list. The entry
 * saves while it is being fixed and publishes once the box is empty.
 */
import { IconAlertTriangle } from "@tabler/icons-react";
import { FieldType, type FieldDef, type SchemaIssue } from "../../api/types";

/** The field now holds a list and the stored value is a single thing — wrapping it loses nothing */
function wrappable(field: FieldDef | undefined, value: unknown): boolean {
  if (!field || value === null || value === undefined || Array.isArray(value)) return false;
  const f = field as unknown as { relationKind?: string; multiple?: boolean; repeatable?: boolean };
  if (field.type === FieldType.Relation) return f.relationKind === "oneToMany" || f.relationKind === "manyToMany";
  if (field.type === FieldType.Media || field.type === FieldType.Taxonomy) return f.multiple === true;
  if (field.type === FieldType.Component) return f.repeatable === true;
  return false;
}

export function NeedsFixingBox({
  issues, fields, storedValues, patch, onFix,
}: {
  issues: SchemaIssue[];
  fields: FieldDef[];
  storedValues: Record<string, unknown>;
  /** unsaved edits — a field already edited is waiting for Save, not for a fix */
  patch: Record<string, unknown>;
  onFix(field: string, value: unknown): void;
}) {
  if (issues.length === 0) return null;
  // one line per field: the first problem is the one to act on, the count says there is more
  const byField = new Map<string, SchemaIssue[]>();
  for (const i of issues) byField.set(i.field, [...(byField.get(i.field) ?? []), i]);

  return (
    <div className="needs-fixing" role="alert">
      <div className="needs-fixing-head">
        <IconAlertTriangle size="1.7rem" />
        <div>
          <strong>Needs fixing — the schema changed</strong>
          <span>
            {byField.size === 1 ? "A field holds" : `${byField.size} fields hold`} a value the field no longer accepts. Other fields
            save as usual; the entry can be published once these are fixed.
          </span>
        </div>
      </div>
      {[...byField.entries()].map(([name, list]) => {
        const field = fields.find((f) => f.name === name);
        const edited = name in patch;
        const first = list[0]!;
        return (
          <div key={name} className="needs-fixing-row">
            <div className="needs-fixing-what">
              <strong>{field?.label ?? name}</strong>
              <span>
                {first.path !== name && <code>{first.path}</code>} {first.message}
                {list.length > 1 && ` (+${list.length - 1} more)`}
              </span>
            </div>
            {edited ? (
              <span className="needs-fixing-pending">Changed — save to apply</span>
            ) : (
              <div className="row-gap">
                {wrappable(field, storedValues[name]) && (
                  <button type="button" className="btn btn-sm" onClick={() => onFix(name, [storedValues[name]])}>Keep as a list</button>
                )}
                <button type="button" className="btn btn-sm" onClick={() => onFix(name, null)}>Clear</button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
