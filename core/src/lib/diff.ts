/** Version diff computation (T1.5) — field-level shallow comparison */

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

export function shallowDiff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, { before: unknown; after: unknown }> {
  const diff: Record<string, { before: unknown; after: unknown }> = {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    if (!same(before[key], after[key])) {
      diff[key] = { before: before[key] ?? null, after: after[key] ?? null };
    }
  }
  return diff;
}
