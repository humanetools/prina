/**
 * uid field type — URL-safe identifier such as slug or SKU.
 * Values are always unique (enforced on save in entry/unique.ts), and if saved empty
 * they are derived from the targetField value (deriveUidValues in entry/unique.ts).
 */
import { z } from "zod";
import { FieldType } from "@prina/shared";
import type { UidFieldDef } from "@prina/shared";
import { baseDefShape } from "./base-def.js";
import type { FieldTypeHandler } from "./registry.js";

/**
 * Slug characters + separators (-,_); cannot start or end with a separator.
 *
 * Letters and digits are matched by Unicode property, not [a-z0-9]: a Korean or Chinese
 * workspace would otherwise get an 8-char id fallback for every URL (found in MCP QA,
 * 2026-08-24). Modern browsers, Google and sitemaps all handle non-ASCII paths — they
 * travel percent-encoded on the wire and render as the original script in the address bar.
 * ASCII slugs are unaffected: every value that validated before still validates.
 */
export const UID_VALUE_PATTERN = "^[\\p{L}\\p{N}]+(?:[-_][\\p{L}\\p{N}]+)*$";

export const uidField: FieldTypeHandler<UidFieldDef> = {
  type: FieldType.Uid,
  defSchema: z.object({
    ...baseDefShape,
    type: z.literal(FieldType.Uid),
    targetField: z.string().optional(),
  }),
  toJsonSchema: () => ({
    type: "string",
    pattern: UID_VALUE_PATTERN,
    maxLength: 200,
  }),
  extractText: (_def, value) => (typeof value === "string" ? value : ""),
  indexHint: (def) => `values->>'${def.name}' (unique generated column candidate)`,
};

/**
 * targetField value → slug.
 *
 * Latin text is folded to ASCII (accents stripped, lowercased) as before. Scripts that have
 * no ASCII equivalent — Hangul, CJK, Cyrillic, Arabic — are kept as themselves rather than
 * dropped: transliterating them would need per-language rules and still produce URLs their
 * readers cannot read. Everything else (punctuation, whitespace, emoji) becomes a separator.
 * The result can still be empty (e.g. a source of only punctuation), so callers keep the
 * entry-id fallback.
 */
export function slugify(source: string): string {
  return source
    .normalize("NFKD")
    // Combining marks: strip only the ones NFKD split off a Latin base, so Hangul
    // (which NFKD decomposes into jamo) is recomposed instead of mangled.
    .replace(/([A-Za-z])[\u0300-\u036f]+/g, "$1")
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}
