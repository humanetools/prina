/**
 * CSV/Excel import (T7.1, §2.8) — parsing, validation report, bulk registration.
 * Execution reuses entry.bulk_create (same path for validation, versions, variants, audit).
 */
import { z } from "zod";
import * as XLSX from "xlsx";
import { FieldType, PermissionAction, contentSubject } from "@prina/shared";
import type { ContentTypeDefinition } from "@prina/shared";
import { defineCommand } from "../../commands/define.js";
import { ValidationError } from "../../lib/errors.js";
import { getContentTypeByUid } from "../content-type/repo.js";
import { validateEntryValues } from "../entry/validate.js";
import { entryBulkCreate } from "../entry/bulk-commands.js";

/** Same as the bulk_create cap (§2.8 bulk insert batch baseline) */
export const IMPORT_MAX_ROWS = 500;
const MAX_FILE_BYTES = 15 * 1024 * 1024;

export interface ParsedSheet {
  sheetName: string;
  columns: string[];
  /** Per-column sample values (input for AI schema inference T7.3) */
  columnSamples: Record<string, unknown[]>;
  rows: Record<string, unknown>[];
  totalRows: number;
  truncated: boolean;
}

/** (1) File parsing — returns columns and all rows (marked truncated when over the cap) */
export const importParse = defineCommand({
  name: "import.parse",
  resource: "import",
  skipAudit: true,
  input: z.object({
    filename: z.string().min(1),
    /** File binary (base64) — CSV/XLSX */
    dataBase64: z.string().min(1),
  }),
  permission: () => ({ action: PermissionAction.Create, subject: contentSubject("*") }),
  async execute(input): Promise<ParsedSheet> {
    const buffer = Buffer.from(input.dataBase64, "base64");
    if (buffer.length > MAX_FILE_BYTES) {
      throw new ValidationError("File is too large (15MB limit)");
    }
    let workbook: XLSX.WorkBook;
    try {
      workbook = XLSX.read(buffer, { type: "buffer" });
    } catch {
      throw new ValidationError("Could not read the file — make sure it is a CSV or Excel (xlsx)");
    }
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) throw new ValidationError("No sheet found");
    const sheet = workbook.Sheets[sheetName]!;
    const allRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
      defval: null,
    });
    if (allRows.length === 0) throw new ValidationError("No data rows");

    const columns = Object.keys(allRows[0]!);
    const rows = allRows.slice(0, IMPORT_MAX_ROWS);
    const columnSamples = Object.fromEntries(
      columns.map((c) => [
        c,
        rows.slice(0, 5).map((r) => r[c]).filter((v) => v !== null),
      ]),
    );
    return {
      sheetName,
      columns,
      columnSamples,
      rows,
      totalRows: allRows.length,
      truncated: allRows.length > IMPORT_MAX_ROWS,
    };
  },
});

/** Applies column→field mapping + field-type-based value coercion (Excel string → number/boolean etc.) */
export function mapRow(
  definition: ContentTypeDefinition,
  mapping: Record<string, string>,
  row: Record<string, unknown>,
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const [column, fieldName] of Object.entries(mapping)) {
    if (!fieldName) continue;
    const field = definition.fields.find((f) => f.name === fieldName);
    if (!field) continue;
    let v = row[column];
    if (v === null || v === undefined || v === "") continue;
    switch (field.type) {
      case FieldType.Number: {
        const n = Number(v);
        v = Number.isFinite(n) ? n : v;
        break;
      }
      case FieldType.Boolean:
        v = ["true", "1", "y", "yes"].includes(String(v).toLowerCase());
        break;
      case FieldType.Text:
      case FieldType.Enum:
      case FieldType.Date:
        v = String(v);
        break;
      default:
        break;
    }
    values[fieldName] = v;
  }
  return values;
}

const mappingSchema = z.record(z.string());
const rowsSchema = z.array(z.record(z.unknown())).min(1).max(IMPORT_MAX_ROWS);

/** (2) Validation report (per-row errors, nothing registered — dry-run) */
export const importValidate = defineCommand({
  name: "import.validate",
  resource: "import",
  skipAudit: true,
  input: z.object({
    typeUid: z.string().min(1),
    mapping: mappingSchema,
    rows: rowsSchema,
  }),
  permission: (i) => ({
    action: PermissionAction.Create,
    subject: contentSubject(i.typeUid),
  }),
  async execute(input, ctx) {
    const contentType = await getContentTypeByUid(ctx.db, ctx.workspaceId, input.typeUid);
    const report: Array<{ row: number; issues: string[] }> = [];
    for (const [index, row] of input.rows.entries()) {
      const values = mapRow(contentType.definition, input.mapping, row);
      try {
        await validateEntryValues(ctx, contentType, values);
      } catch (e) {
        const issues =
          e instanceof ValidationError
            ? ((e.details as { issues?: string[] })?.issues ?? [e.message])
            : ["Validation failed"];
        report.push({ row: index, issues });
      }
    }
    return {
      total: input.rows.length,
      validCount: input.rows.length - report.length,
      errors: report,
    };
  },
});

/** (3) Execution — applies mapping then delegates to bulk_create (same command as MCP) */
export const importExecute = defineCommand({
  name: "import.execute",
  resource: "import",
  input: z.object({
    typeUid: z.string().min(1),
    locale: z.string().optional(),
    mapping: mappingSchema,
    rows: rowsSchema,
  }),
  permission: (i) => ({
    action: PermissionAction.Create,
    subject: contentSubject(i.typeUid),
  }),
  async execute(input, ctx) {
    const contentType = await getContentTypeByUid(ctx.db, ctx.workspaceId, input.typeUid);
    return entryBulkCreate.run(
      {
        typeUid: input.typeUid,
        locale: input.locale,
        items: input.rows.map((row) => ({
          values: mapRow(contentType.definition, input.mapping, row),
        })),
      },
      ctx,
    );
  },
  auditPayload: (i, o: { createdCount: number; failed: unknown[] }) => ({
    typeUid: i.typeUid,
    rows: i.rows.length,
    created: o.createdCount,
    failed: o.failed.length,
  }),
});
