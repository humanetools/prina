/**
 * Slug for a new taxonomy node, derived from its name so creating a node only asks for a name.
 * Server rule: ^[a-z0-9][a-z0-9_-]{0,63}$, and the ltree path label maps `-` to `_` — so uniqueness
 * among siblings is checked on that label. Names with no latin letters or digits fall back to "node".
 */
const label = (slug: string) => slug.replace(/[^a-zA-Z0-9_]/g, "_");

export function slugForNode(name: string, siblingSlugs: string[]): string {
  const base =
    name
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 56) || "node";
  const taken = new Set(siblingSlugs.map(label));
  if (!taken.has(label(base))) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(label(candidate))) return candidate;
  }
}
