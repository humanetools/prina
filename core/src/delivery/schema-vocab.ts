/**
 * schema.org vocabulary (T9.1 extension) — type hierarchy + property domains.
 * schema-org-vocab.json is a compact extract from the official schema.org release (jsonld):
 * {parents: {class→parents}, props: {property→domainIncludes}}.
 */
import vocabJson from "./schema-org-vocab.json" with { type: "json" };

const vocab = vocabJson as {
  parents: Record<string, string[]>;
  props: Record<string, string[]>;
  inverse: Record<string, string>;
};

const ancestorCache = new Map<string, Set<string>>();

/** Set of the type's own + ancestor classes (up to Thing) */
export function ancestorsOf(type: string): Set<string> {
  const hit = ancestorCache.get(type);
  if (hit) return hit;
  const seen = new Set<string>();
  const walk = (t: string) => {
    if (seen.has(t)) return;
    seen.add(t);
    for (const p of vocab.parents[t] ?? []) walk(p);
  };
  walk(type);
  ancestorCache.set(type, seen);
  return seen;
}

export function isKnownType(type: string): boolean {
  return type in vocab.parents;
}

/** Whether property prop is valid on any of the given types (self + ancestors included) */
export function isValidProperty(prop: string, types: string[]): boolean {
  const domains = vocab.props[prop];
  if (!domains) return false;
  for (const t of types) {
    const anc = ancestorsOf(t);
    if (domains.some((d) => anc.has(d))) return true;
  }
  return false;
}

/** Standard inverse predicate (schema.org inverseOf, augmented bidirectionally) — null if none */
export function inverseOf(prop: string): string | null {
  return vocab.inverse[prop] ?? null;
}

/** Full class list (name + direct parents) — for the admin combobox search */
export function listTypes(): Array<{ name: string; parents: string[] }> {
  return Object.entries(vocab.parents)
    .map(([name, parents]) => ({ name, parents }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Full property list (name + domains) — for predicate autocomplete */
export function listProperties(): Array<{ name: string; domains: string[] }> {
  return Object.entries(vocab.props)
    .map(([name, domains]) => ({ name, domains }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Batch-validate multiple properties — used by the admin tab */
export function validateProperties(
  props: string[],
  types: string[],
): Record<string, boolean> {
  const known = types.filter(isKnownType);
  const out: Record<string, boolean> = {};
  for (const p of props) out[p] = known.length > 0 && isValidProperty(p, known);
  return out;
}
