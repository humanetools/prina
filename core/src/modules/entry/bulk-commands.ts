/** Bulk create command (service layer for T6.2 {type}_bulk_create, also reused by T7.1 import) */
import { z } from "zod";
import { PermissionAction, contentSubject } from "@prina/shared";
import { defineCommand } from "../../commands/define.js";
import { AppError } from "../../lib/errors.js";
import { entryCreate } from "./commands.js";

export const entryBulkCreate = defineCommand({
  name: "entry.bulk_create",
  resource: "entry",
  input: z.object({
    typeUid: z.string().min(1),
    locale: z.string().optional(),
    items: z.array(z.object({ values: z.record(z.unknown()) })).min(1).max(500),
  }),
  permission: (i) => ({
    action: PermissionAction.Create,
    subject: contentSubject(i.typeUid),
    locale: i.locale,
  }),
  async execute(input, ctx) {
    const created: string[] = [];
    // `issues` names the offending fields. Without it a 500-row batch that fails validation
    // says only "Values violate the content type schema", and the caller has to replay rows
    // one at a time through entry_create to find out why (MCP QA, 2026-08-24).
    const failed: Array<{ index: number; error: string; issues?: string[] }> = [];
    for (const [index, item] of input.items.entries()) {
      try {
        // Reuse the single-create command — validation, versions, variants, audit all share the same path
        const saved = await entryCreate.run(
          { typeUid: input.typeUid, values: item.values, locale: input.locale },
          ctx,
        );
        created.push(saved.entry.id);
      } catch (e) {
        const issues =
          e instanceof AppError && e.details && typeof e.details === "object"
            ? (e.details as { issues?: unknown }).issues
            : undefined;
        failed.push({
          index,
          error: e instanceof AppError ? e.message : "Creation failed",
          ...(Array.isArray(issues) ? { issues: issues.map(String) } : {}),
        });
      }
    }
    return { createdCount: created.length, createdIds: created, failed };
  },
  auditPayload: (i, o) => ({
    typeUid: i.typeUid,
    requested: i.items.length,
    created: o.createdCount,
    failed: o.failed.length,
  }),
});
