export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes(),
  ).padStart(2, "0")}`;
}

export function displayValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "(empty)";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v).slice(0, 60);
}

/**
 * Display field — falls back to the first text/uid/enum field when displayField is unset (Strapi mainField behavior).
 * Returns null when none — callers fall back to id.
 */
export function effectiveDisplayField(definition: {
  displayField?: string;
  fields: Array<{ name: string; type: string }>;
}): string | null {
  if (definition.displayField) return definition.displayField;
  const first = definition.fields.find((f) =>
    f.type === "text" || f.type === "uid" || f.type === "enum",
  );
  return first?.name ?? null;
}

/** One-line entry label — display field value, else first 8 chars of id */
export function entryLabel(
  definition: { displayField?: string; fields: Array<{ name: string; type: string }> },
  values: Record<string, unknown>,
  id: string,
): string {
  const df = effectiveDisplayField(definition);
  return df ? displayValue(values[df]) : id.slice(0, 8);
}
