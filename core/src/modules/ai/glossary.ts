/**
 * Translation glossary helpers (37-IMPL-translation-glossary) — pure functions shared by the
 * glossary commands and the locale translator. A glossary row is one concept worded per
 * locale; the translator only ever sees the pairs that matter for the text in hand.
 */
import * as XLSX from "xlsx";
import type { AiGlossaryRow } from "@prina/shared";

/** Hard caps — the grid is hand-maintained, not a TM dump */
export const GLOSSARY_MAX_ROWS = 5000;
export const GLOSSARY_MAX_TERM_LENGTH = 500;
/** Pairs sent to the model per translation call — more dilutes attention, not accuracy */
export const GLOSSARY_MAX_PROMPT_PAIRS = 300;

export interface GlossaryPair {
  source: string;
  target: string;
}

/** Trim every cell, drop empties, drop rows with no wording in any locale */
export function normalizeTerms(terms: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [code, raw] of Object.entries(terms)) {
    if (typeof raw !== "string") continue;
    const v = raw.trim();
    if (v) out[code] = v;
  }
  return out;
}

/**
 * Pairs the translator must honour for source→target: both cells filled, and the source
 * wording actually present in the text being translated (case-insensitive substring).
 * Longest source first so a compound term wins over a term it contains.
 */
export function glossaryPairs(
  rows: ReadonlyArray<Pick<AiGlossaryRow, "terms">>,
  sourceLocale: string,
  targetLocale: string,
  texts: ReadonlyArray<string>,
  max = GLOSSARY_MAX_PROMPT_PAIRS,
): GlossaryPair[] {
  if (sourceLocale === targetLocale) return [];
  const haystack = texts.join("\n").toLowerCase();
  if (!haystack.trim()) return [];
  const seen = new Set<string>();
  const pairs: GlossaryPair[] = [];
  for (const row of rows) {
    const source = row.terms[sourceLocale]?.trim();
    const target = row.terms[targetLocale]?.trim();
    if (!source || !target) continue;
    const key = source.toLowerCase();
    if (seen.has(key) || !haystack.includes(key)) continue;
    seen.add(key);
    pairs.push({ source, target });
  }
  pairs.sort((a, b) => b.source.length - a.source.length);
  return pairs.slice(0, max);
}

/** System-prompt block — one rule line per pair, JSON-quoted so spaces and quotes survive */
export function glossaryPromptBlock(pairs: ReadonlyArray<GlossaryPair>): string {
  if (pairs.length === 0) return "";
  const lines = pairs.map((p) => `  ${JSON.stringify(p.source)} → ${JSON.stringify(p.target)}`);
  return `- GLOSSARY — the workspace glossary fixes these terms. Wherever the source wording appears, use the target wording exactly as given (inflect only as the target grammar strictly requires):\n${lines.join("\n")}`;
}

// ── Excel ───────────────────────────────────────────────────────────────────────────────────

export interface GlossaryLocale {
  code: string;
  name: string;
}

/** Workbook bytes: header row = locale codes in the given order, one row per glossary row */
export function glossaryToXlsx(
  rows: ReadonlyArray<Pick<AiGlossaryRow, "terms">>,
  locales: ReadonlyArray<GlossaryLocale>,
): Buffer {
  const codes = locales.map((l) => l.code);
  const aoa: string[][] = [codes, ...rows.map((r) => codes.map((c) => r.terms[c] ?? ""))];
  const sheet = XLSX.utils.aoa_to_sheet(aoa);
  // column widths so the file opens readable — chars, capped
  sheet["!cols"] = codes.map((c) => ({
    wch: Math.min(60, Math.max(12, ...rows.map((r) => (r.terms[c] ?? "").length), c.length)),
  }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, "Glossary");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

/**
 * Header → locale code. Accepts the code ("ko"), the locale name ("Korean") or "Korean (ko)" —
 * a human may well retitle the columns before uploading. Case-insensitive.
 */
export function resolveHeaderLocale(
  header: string,
  locales: ReadonlyArray<GlossaryLocale>,
): string | null {
  const h = header.trim().toLowerCase();
  if (!h) return null;
  const paren = h.match(/\(([^()]+)\)\s*$/)?.[1]?.trim();
  for (const l of locales) {
    const code = l.code.toLowerCase();
    if (h === code || paren === code || h === l.name.trim().toLowerCase()) return l.code;
  }
  return null;
}

export interface ParsedGlossary {
  rows: Array<{ terms: Record<string, string> }>;
  /** Locale codes the sheet carried (in sheet order) */
  columns: string[];
  /** Headers that matched no registered locale — their cells were dropped */
  ignoredColumns: string[];
  totalRows: number;
}

/** First sheet of a CSV/XLSX → glossary rows. Throws on an unreadable file or no usable column */
export function xlsxToGlossary(
  buffer: Buffer,
  locales: ReadonlyArray<GlossaryLocale>,
): ParsedGlossary {
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(buffer, { type: "buffer" });
  } catch {
    throw new Error("Could not read the file — make sure it is a CSV or Excel (xlsx)");
  }
  const name = wb.SheetNames[0];
  if (!name) throw new Error("No sheet found");
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name]!, { header: 1, defval: "" });
  const headerRow = (aoa[0] ?? []).map((h) => String(h ?? ""));
  const mapping: Array<string | null> = headerRow.map((h) => resolveHeaderLocale(h, locales));
  const columns: string[] = [];
  const ignoredColumns: string[] = [];
  mapping.forEach((code, i) => {
    const h = headerRow[i]!.trim();
    if (code && !columns.includes(code)) columns.push(code);
    else if (h && !code) ignoredColumns.push(h);
  });
  if (columns.length === 0) {
    throw new Error("No column matches a registered locale — the header row must carry locale codes such as 'ko', 'en'");
  }
  const rows: ParsedGlossary["rows"] = [];
  for (const cells of aoa.slice(1)) {
    const terms: Record<string, string> = {};
    mapping.forEach((code, i) => {
      if (!code || code in terms) return;
      const v = String(cells[i] ?? "").trim();
      if (v) terms[code] = v.slice(0, GLOSSARY_MAX_TERM_LENGTH);
    });
    if (Object.keys(terms).length > 0) rows.push({ terms });
  }
  return { rows: rows.slice(0, GLOSSARY_MAX_ROWS), columns, ignoredColumns, totalRows: rows.length };
}
