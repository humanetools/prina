/** Locale management commands (T2.4) — shared by Settings and MCP */
import { z } from "zod";
import { and, asc, eq, sql } from "drizzle-orm";
import { PermissionAction, SystemSubject } from "@prina/shared";
import { entries, locales } from "../../db/schema/index.js";
import { defineCommand } from "../../commands/define.js";
import { ConflictError, NotFoundError, ValidationError } from "../../lib/errors.js";
import type { Db } from "../../db/client.js";

const codeSchema = z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/, "BCP 47 format");

export const localeList = defineCommand({
  name: "locale.list",
  resource: "locale",
  skipAudit: true,
  input: z.object({}).default({}),
  async execute(_input, ctx) {
    // entryCount is the basis for deletability — the screen must be able to preview what the server blocks
    const rows = await ctx.db
      .select({
        id: locales.id,
        workspaceId: locales.workspaceId,
        code: locales.code,
        name: locales.name,
        isDefault: locales.isDefault,
        createdAt: locales.createdAt,
        entryCount: sql<number>`(
          select count(*) from ${entries}
          where ${entries.workspaceId} = ${locales.workspaceId}
            and ${entries.locale} = ${locales.code}
        )`.mapWith(Number),
      })
      .from(locales)
      .where(eq(locales.workspaceId, ctx.workspaceId))
      .orderBy(asc(locales.code));
    return rows;
  },
});

export const localeCreate = defineCommand({
  name: "locale.create",
  resource: "locale",
  input: z.object({
    code: codeSchema,
    name: z.string().min(1).max(100),
    isDefault: z.boolean().default(false),
  }),
  permission: () => ({
    action: PermissionAction.Create,
    subject: SystemSubject.Locales,
  }),
  async execute(input, ctx) {
    const [existing] = await ctx.db
      .select({ id: locales.id })
      .from(locales)
      .where(and(eq(locales.workspaceId, ctx.workspaceId), eq(locales.code, input.code)))
      .limit(1);
    if (existing) throw new ConflictError(`Locale '${input.code}' already exists`);
    if (input.isDefault) {
      await ctx.db
        .update(locales)
        .set({ isDefault: false })
        .where(eq(locales.workspaceId, ctx.workspaceId));
    }
    const [row] = await ctx.db
      .insert(locales)
      .values({ workspaceId: ctx.workspaceId, ...input })
      .returning();
    return row!;
  },
  resourceId: (_i, o) => o.id,
  auditPayload: (i) => ({ code: i.code }),
});

/** Rename a locale or promote it to default — the U in the locale CRUD */
export const localeUpdate = defineCommand({
  name: "locale.update",
  resource: "locale",
  input: z.object({
    code: codeSchema,
    name: z.string().min(1).max(100).optional(),
    isDefault: z.literal(true).optional(),
  }),
  permission: () => ({
    action: PermissionAction.Update,
    subject: SystemSubject.Locales,
  }),
  async execute(input, ctx) {
    const [row] = await ctx.db
      .select()
      .from(locales)
      .where(and(eq(locales.workspaceId, ctx.workspaceId), eq(locales.code, input.code)))
      .limit(1);
    if (!row) throw new NotFoundError(`Locale '${input.code}' not found`);
    // Exactly one default per workspace — clear the others first, same as localeCreate
    if (input.isDefault) {
      await ctx.db
        .update(locales)
        .set({ isDefault: false })
        .where(eq(locales.workspaceId, ctx.workspaceId));
    }
    const [updated] = await ctx.db
      .update(locales)
      .set({
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.isDefault ? { isDefault: true } : {}),
      })
      .where(eq(locales.id, row.id))
      .returning();
    return updated!;
  },
  resourceId: (_i, o) => o.id,
  auditPayload: (i) => ({ code: i.code, isDefault: i.isDefault ?? false }),
});

export const localeDelete = defineCommand({
  name: "locale.delete",
  resource: "locale",
  input: z.object({ code: codeSchema }),
  permission: () => ({
    action: PermissionAction.Delete,
    subject: SystemSubject.Locales,
  }),
  async execute(input, ctx) {
    const [row] = await ctx.db
      .select()
      .from(locales)
      .where(and(eq(locales.workspaceId, ctx.workspaceId), eq(locales.code, input.code)))
      .limit(1);
    if (!row) throw new NotFoundError(`Locale '${input.code}' not found`);
    if (row.isDefault) throw new ValidationError("The default locale cannot be deleted");
    const [entryExists] = await ctx.db
      .select({ id: entries.id })
      .from(entries)
      .where(and(eq(entries.workspaceId, ctx.workspaceId), eq(entries.locale, input.code)))
      .limit(1);
    if (entryExists) {
      throw new ConflictError("Entries still use this locale — remove them first");
    }
    await ctx.db.delete(locales).where(eq(locales.id, row.id));
    return { code: input.code };
  },
  auditPayload: (i) => ({ code: i.code }),
});

/** Assert the locale is registered in the workspace (used on the entry save path) */
export async function assertLocaleExists(
  ctx: { db: Db; workspaceId: string },
  code: string,
): Promise<void> {
  const [row] = await ctx.db
    .select({ id: locales.id })
    .from(locales)
    .where(and(eq(locales.workspaceId, ctx.workspaceId), eq(locales.code, code)))
    .limit(1);
  if (!row) {
    throw new ValidationError(
      `Locale '${code}' is not registered in this workspace (Settings › Locales)`,
    );
  }
}
