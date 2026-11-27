/** Workspace settings commands — global dataLayer defaults (currency etc., T5.4/P11 system) */
import { z } from "zod";
import { and, asc, count, eq, sql } from "drizzle-orm";
import { DefaultRole, PermissionAction, SystemSubject } from "@prina/shared";
import { assets, locales, roles, userRoles, users, workspaces } from "../../db/schema/index.js";
import type { CommandCtx } from "../../commands/context.js";
import { defineCommand } from "../../commands/define.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../../lib/errors.js";
import { seedWorkspaceDefaults } from "../../bootstrap.js";

export const workspaceGetSettings = defineCommand({
  name: "workspace.get_settings",
  resource: "workspace",
  skipAudit: true,
  input: z.object({}).default({}),
  async execute(_input, ctx) {
    const [ws] = await ctx.db
      .select({ id: workspaces.id, name: workspaces.name, settings: workspaces.settings })
      .from(workspaces)
      .where(eq(workspaces.id, ctx.workspaceId))
      .limit(1);
    return ws!;
  },
});

export const workspaceUpdateSettings = defineCommand({
  name: "workspace.update_settings",
  resource: "workspace",
  input: z.object({
    /** merge patch — currency etc. (e.g. { currency: "KRW" }) */
    settings: z.record(z.unknown()),
  }),
  // Preview assets (43-IMPL) are template tooling — the people who edit markup (developer/editor roles) set them
  // too. A patch that touches only `previewAssets` needs templates:update; anything else stays settings:update.
  // (2026-11-05: the hikrobot FE team got 403 saving Settings › System › Preview assets.)
  permission: (i) => {
    const keys = Object.keys(i.settings ?? {});
    const previewOnly = keys.length > 0 && keys.every((k) => k === "previewAssets");
    return { action: PermissionAction.Update, subject: previewOnly ? SystemSubject.Templates : SystemSubject.Settings };
  },
  async execute(input, ctx) {
    const [current] = await ctx.db
      .select({ settings: workspaces.settings })
      .from(workspaces)
      .where(eq(workspaces.id, ctx.workspaceId))
      .limit(1);
    const merged = { ...(current?.settings ?? {}), ...input.settings };
    const [row] = await ctx.db
      .update(workspaces)
      .set({ settings: merged, updatedAt: new Date() })
      .where(eq(workspaces.id, ctx.workspaceId))
      .returning();
    return { id: row!.id, settings: row!.settings };
  },
  auditPayload: (i) => ({ keys: Object.keys(i.settings) }),
});

/** Workspaces belong to the whole install — every change to the set is for instance administrators */
async function requireInstanceAdmin(ctx: CommandCtx, what: string): Promise<{ id: string }> {
  const [actor] = ctx.actor.id
    ? await ctx.db.select({ id: users.id, isInstanceAdmin: users.isInstanceAdmin }).from(users).where(eq(users.id, ctx.actor.id)).limit(1)
    : [];
  if (!actor?.isInstanceAdmin) throw new ForbiddenError(`Only instance administrators can ${what}`);
  return { id: actor.id };
}

/** Workspaces per install, primary included — every edition (user decision 2026-11-15) */
export const MAX_WORKSPACES = 30;

/** The workspace the delivery API and the admin fall back to — never deleted */
export const PRIMARY_WORKSPACE_SLUG = "default";

/** Slugs that would read as something else in URLs, headers or the admin */
const RESERVED_SLUGS = new Set(["api", "admin", "delivery", "new", "settings", "system", "all", "none", "null", "undefined"]);

export const workspaceSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/, "Use 2–40 lowercase letters, digits and hyphens (no hyphen at either end)")
  .min(2)
  .refine((s) => !RESERVED_SLUGS.has(s), "This name is reserved");

/**
 * Create a workspace (48-IMPL) — instance administrators only: a workspace is a resource of the whole
 * install, not of any one workspace. It gets the install's workflow, the four default roles and its own
 * default locale; the creator is made its admin so it shows up in the Users list with a role.
 * The slug is permanent — the delivery API (?ws=) and preview tokens address the workspace by it.
 */
export const workspaceCreate = defineCommand({
  name: "workspace.create",
  resource: "workspace",
  input: z.object({
    name: z.string().trim().min(1).max(80),
    slug: workspaceSlugSchema,
    defaultLocale: z
      .object({ code: z.string().trim().regex(/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/, "Use a locale code such as en, ko or en-US"), name: z.string().trim().min(1).max(60) })
      .optional(),
  }),
  async execute(input, ctx) {
    const actor = await requireInstanceAdmin(ctx, "create workspaces");

    const [{ n }] = (await ctx.db.select({ n: count() }).from(workspaces)) as [{ n: number }];
    if (Number(n) >= MAX_WORKSPACES) {
      throw new ConflictError(`This install already has the maximum of ${MAX_WORKSPACES} workspaces — delete one before creating another`);
    }
    const [taken] = await ctx.db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.slug, input.slug)).limit(1);
    if (taken) throw new ConflictError(`A workspace named '${input.slug}' already exists`);

    // Without a choice, follow the first workspace's default locale
    let locale = input.defaultLocale;
    if (!locale) {
      const [first] = await ctx.db
        .select({ code: locales.code, name: locales.name })
        .from(locales)
        .innerJoin(workspaces, eq(workspaces.id, locales.workspaceId))
        .where(eq(locales.isDefault, true))
        .orderBy(asc(workspaces.createdAt))
        .limit(1);
      locale = first ?? { code: "en", name: "English" };
    }

    const [ws] = await ctx.db.insert(workspaces).values({ slug: input.slug, name: input.name }).returning();
    await seedWorkspaceDefaults(ctx.db, ws!.id, ctx.services.workflowPreset, locale);
    const [admin] = await ctx.db
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.workspaceId, ws!.id), eq(roles.name, DefaultRole.Admin)))
      .limit(1);
    if (admin) await ctx.db.insert(userRoles).values({ userId: actor.id, roleId: admin.id, workspaceId: ws!.id });
    return ws!;
  },
  resourceId: (_i, o) => o.id,
  auditPayload: (i) => ({ slug: i.slug, name: i.name }),
});

/** Rename a workspace (48-IMPL). The slug stays — addresses (?ws=, MCP) depend on it. */
export const workspaceUpdate = defineCommand({
  name: "workspace.update",
  resource: "workspace",
  input: z.object({ id: z.string().uuid(), name: z.string().trim().min(1).max(80) }),
  async execute(input, ctx) {
    await requireInstanceAdmin(ctx, "rename workspaces");
    const [row] = await ctx.db
      .update(workspaces)
      .set({ name: input.name, updatedAt: new Date() })
      .where(eq(workspaces.id, input.id))
      .returning();
    if (!row) throw new NotFoundError(`Workspace ${input.id} not found`);
    return row;
  },
  resourceId: (i) => i.id,
  auditPayload: (i) => ({ name: i.name }),
});

/**
 * Delete a workspace and everything in it (48-IMPL). The caller repeats the slug to confirm.
 * The primary workspace (`default`) cannot be deleted — the delivery API and the admin fall back to it.
 *
 * Core tables go with the workspace row (ON DELETE CASCADE). Tables some editions create without a
 * foreign key (EE chatbot / Flow) are cleared by name: every public table with a `workspace_id`
 * column that the cascade does not cover. Asset files are removed from storage best effort; cached
 * derivatives of protected assets are left (they cannot be listed and are unreachable once the asset is gone).
 */
export const workspaceDelete = defineCommand({
  name: "workspace.delete",
  resource: "workspace",
  input: z.object({ id: z.string().uuid(), confirm: z.string() }),
  async execute(input, ctx) {
    await requireInstanceAdmin(ctx, "delete workspaces");
    const [ws] = await ctx.db.select().from(workspaces).where(eq(workspaces.id, input.id)).limit(1);
    if (!ws) throw new NotFoundError(`Workspace ${input.id} not found`);
    if (ws.slug === PRIMARY_WORKSPACE_SLUG) throw new ValidationError("The primary workspace cannot be deleted");
    if (input.confirm.trim() !== ws.slug) throw new ValidationError(`Type the workspace slug '${ws.slug}' to confirm`);

    const files = await ctx.db.select({ key: assets.storageKey }).from(assets).where(eq(assets.workspaceId, ws.id));

    // Tables with a workspace_id the cascade does not reach (no foreign key to workspaces)
    const loose = (await ctx.db.execute(sql`
      SELECT c.table_name AS t
      FROM information_schema.columns c
      WHERE c.table_schema = 'public' AND c.column_name = 'workspace_id'
        AND NOT EXISTS (
          SELECT 1 FROM information_schema.key_column_usage k
          JOIN information_schema.referential_constraints rc ON rc.constraint_name = k.constraint_name
          WHERE k.table_schema = 'public' AND k.table_name = c.table_name AND k.column_name = 'workspace_id'
        )
    `)) as unknown as { rows?: Array<{ t: string }> } | Array<{ t: string }>;
    const tables = (Array.isArray(loose) ? loose : (loose.rows ?? [])).map((r) => r.t);
    for (const t of tables) {
      await ctx.db.execute(sql`DELETE FROM ${sql.identifier(t)} WHERE workspace_id = ${ws.id}`);
    }
    await ctx.db.delete(workspaces).where(eq(workspaces.id, ws.id));

    // Storage last: if the database part failed nothing is lost. Best effort, a few at a time.
    let removed = 0;
    const queue = [...files];
    const worker = async () => {
      for (let f = queue.shift(); f; f = queue.shift()) {
        try { await ctx.services.storage.adapter.delete(f.key); removed++; } catch { /* left in storage */ }
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    return { id: ws.id, slug: ws.slug, files: files.length, filesRemoved: removed, looseTables: tables.length };
  },
  resourceId: (_i, o) => o.id,
  auditPayload: (_i, o) => ({ slug: o.slug, files: o.files, filesRemoved: o.filesRemoved }),
});
