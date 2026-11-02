/**
 * Translation glossary commands (37-IMPL-translation-glossary) — the grid is saved whole
 * (order = array order), exported to and loaded from Excel. Reads are what the translator
 * uses too (loadGlossaryRows), so a saved term applies to the very next translation.
 */
import { z } from "zod";
import { asc, eq } from "drizzle-orm";
import { PermissionAction, SystemSubject } from "@prina/shared";
import type { AiGlossaryRow } from "@prina/shared";
import { aiGlossaryTerms, locales } from "../../db/schema/index.js";
import type { Db } from "../../db/client.js";
import { defineCommand } from "../../commands/define.js";
import { ValidationError } from "../../lib/errors.js";
import {
  GLOSSARY_MAX_ROWS,
  GLOSSARY_MAX_TERM_LENGTH,
  glossaryToXlsx,
  normalizeTerms,
  xlsxToGlossary,
  type GlossaryLocale,
} from "./glossary.js";

const MAX_FILE_BYTES = 15 * 1024 * 1024;

export async function loadGlossaryRows(db: Db, workspaceId: string): Promise<AiGlossaryRow[]> {
  const rows = await db
    .select({ id: aiGlossaryTerms.id, terms: aiGlossaryTerms.terms })
    .from(aiGlossaryTerms)
    .where(eq(aiGlossaryTerms.workspaceId, workspaceId))
    .orderBy(asc(aiGlossaryTerms.position), asc(aiGlossaryTerms.createdAt));
  return rows;
}

/** Locales in grid order — the default first, the rest by code (same as Settings › Locales) */
export async function glossaryLocales(db: Db, workspaceId: string): Promise<GlossaryLocale[]> {
  const rows = await db
    .select({ code: locales.code, name: locales.name, isDefault: locales.isDefault })
    .from(locales)
    .where(eq(locales.workspaceId, workspaceId))
    .orderBy(asc(locales.code));
  return [...rows.filter((l) => l.isDefault), ...rows.filter((l) => !l.isDefault)].map((l) => ({
    code: l.code,
    name: l.name,
  }));
}

export const aiGlossaryGet = defineCommand({
  name: "ai_glossary.get",
  resource: "ai_glossary",
  skipAudit: true,
  input: z.object({}).default({}),
  permission: () => ({ action: PermissionAction.Read, subject: SystemSubject.Settings }),
  async execute(_input, ctx) {
    return {
      locales: await glossaryLocales(ctx.db, ctx.workspaceId),
      rows: await loadGlossaryRows(ctx.db, ctx.workspaceId),
    };
  },
});

const rowInput = z.object({
  /** Existing row id keeps its identity; omitted = new row */
  id: z.string().uuid().optional(),
  terms: z.record(z.string().min(1).max(20), z.string().max(GLOSSARY_MAX_TERM_LENGTH)),
});

/** Replace the whole glossary — rows with no wording in any locale are dropped */
export const aiGlossarySet = defineCommand({
  name: "ai_glossary.set",
  resource: "ai_glossary",
  input: z.object({ rows: z.array(rowInput).max(GLOSSARY_MAX_ROWS) }),
  permission: () => ({ action: PermissionAction.Update, subject: SystemSubject.Settings }),
  async execute(input, ctx) {
    const known = new Set((await glossaryLocales(ctx.db, ctx.workspaceId)).map((l) => l.code));
    const existing = new Set((await loadGlossaryRows(ctx.db, ctx.workspaceId)).map((r) => r.id));
    const cleaned = input.rows
      .map((r) => ({
        id: r.id && existing.has(r.id) ? r.id : undefined,
        terms: Object.fromEntries(
          Object.entries(normalizeTerms(r.terms)).filter(([code]) => known.has(code)),
        ),
      }))
      .filter((r) => Object.keys(r.terms).length > 0);
    const dupIds = cleaned.map((r) => r.id).filter((id): id is string => !!id);
    if (new Set(dupIds).size !== dupIds.length) {
      throw new ValidationError("A glossary row id appears twice");
    }

    await ctx.db.delete(aiGlossaryTerms).where(eq(aiGlossaryTerms.workspaceId, ctx.workspaceId));
    if (cleaned.length > 0) {
      await ctx.db.insert(aiGlossaryTerms).values(
        cleaned.map((r, i) => ({
          ...(r.id ? { id: r.id } : {}),
          workspaceId: ctx.workspaceId,
          position: i,
          terms: r.terms,
        })),
      );
    }
    return { rows: await loadGlossaryRows(ctx.db, ctx.workspaceId) };
  },
  auditPayload: (_i, o) => ({ rowCount: o.rows.length }),
});

/** xlsx bytes (base64) — header = locale codes in grid order */
export const aiGlossaryExport = defineCommand({
  name: "ai_glossary.export",
  resource: "ai_glossary",
  skipAudit: true,
  input: z.object({}).default({}),
  permission: () => ({ action: PermissionAction.Read, subject: SystemSubject.Settings }),
  async execute(_input, ctx) {
    const locs = await glossaryLocales(ctx.db, ctx.workspaceId);
    const rows = await loadGlossaryRows(ctx.db, ctx.workspaceId);
    return { filename: "prina-glossary.xlsx", dataBase64: glossaryToXlsx(rows, locs).toString("base64") };
  },
});

/** Parse an uploaded CSV/XLSX into glossary rows — nothing is saved; the grid saves on "Save" */
export const aiGlossaryParse = defineCommand({
  name: "ai_glossary.parse",
  resource: "ai_glossary",
  skipAudit: true,
  input: z.object({
    filename: z.string().min(1),
    /** File binary (base64) — CSV/XLSX */
    dataBase64: z.string().min(1),
  }),
  permission: () => ({ action: PermissionAction.Update, subject: SystemSubject.Settings }),
  async execute(input, ctx) {
    const buffer = Buffer.from(input.dataBase64, "base64");
    if (buffer.length > MAX_FILE_BYTES) throw new ValidationError("File is too large (15MB limit)");
    const locs = await glossaryLocales(ctx.db, ctx.workspaceId);
    try {
      return xlsxToGlossary(buffer, locs);
    } catch (e) {
      throw new ValidationError(e instanceof Error ? e.message : "Could not read the file");
    }
  },
});
