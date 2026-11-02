/**
 * Template partials (39-IMPL) — reusable Liquid fragments a page template pulls in with
 * `{% render 'ds.hero' with blk as blk %}`. One partial per design-system component; the page
 * template is a loop over a dynamic zone that dispatches on `blk.__component`.
 *
 * Two sources per version: `liquid` (what delivery serves) and `liquidEdit` (same markup with
 * authoring markers `data-blk` / `data-prop`, used only by preview `edit: true`). Versioned like
 * templates (new row per save, one current); js follows the template_script lock.
 */
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { PermissionAction, SystemSubject } from "@prina/shared";
import type { Db } from "../../db/client.js";
import { components, templatePartials } from "../../db/schema/index.js";
import { defineCommand } from "../../commands/define.js";
import { AppError, NotFoundError } from "../../lib/errors.js";
import type { CommandCtx } from "../../commands/context.js";
import { assertPermissionInExecute, canActor } from "../rbac/service.js";
import { renderLiquid, type PartialSource } from "../../delivery/liquid.js";

/** `ds.hero`, `blocks.card-grid`, `footer` — lowercase, dot-separated segments */
export const partialName = z
  .string()
  .max(120)
  .regex(/^[a-z][a-z0-9_-]*(\.[a-z0-9_-]+)*$/, "Partial name: lowercase letters, digits, _ - and dots (ds.hero)");

const SOURCE_MAX = 200_000;

export type PartialRow = typeof templatePartials.$inferSelect;

/**
 * Component markup (40-IMPL): a partial named exactly like a component uid is that component's
 * markup, and it exists only while the component's markup toggle is on. Returns every component
 * uid in the workspace with its effective state — used by the loader (off = the partial is
 * invisible to render), by save (off = 409) and by the list.
 *
 * Effective state: `options.markup` true/false when set. When the key was never set, a component
 * that already has a current partial counts as on — installs that published partials before the
 * toggle existed (Authoring Tool ≤ 0.1.0 on core 0.5.17) keep rendering after the upgrade; a
 * component without one is off until someone turns it on.
 */
export async function loadComponentMarkupFlags(
  db: Db,
  workspaceId: string,
): Promise<Map<string, boolean>> {
  const [rows, partials] = await Promise.all([
    db
      .select({ uid: components.uid, options: components.options })
      .from(components)
      .where(eq(components.workspaceId, workspaceId)),
    db
      .select({ name: templatePartials.name })
      .from(templatePartials)
      .where(and(eq(templatePartials.workspaceId, workspaceId), eq(templatePartials.isCurrent, true))),
  ]);
  const withPartial = new Set(partials.map((p) => p.name));
  return new Map(rows.map((r) => [r.uid, effectiveMarkup(r.uid, r.options, withPartial)]));
}

export function effectiveMarkup(
  uid: string,
  options: Record<string, unknown>,
  namesWithPartial: ReadonlySet<string>,
): boolean {
  const flag = (options as { markup?: unknown }).markup;
  if (flag === true) return true;
  if (flag === false) return false;
  return namesWithPartial.has(uid);
}

export class ComponentMarkupDisabledError extends AppError {
  constructor(uid: string) {
    super(
      "COMPONENT_MARKUP_DISABLED",
      `Component '${uid}' has markup turned off — enable it in the component's Markup tab (options.markup) first`,
      409,
    );
  }
}

export async function getCurrentPartial(
  ctx: Pick<CommandCtx, "db" | "workspaceId">,
  name: string,
): Promise<PartialRow | undefined> {
  const [row] = await ctx.db
    .select()
    .from(templatePartials)
    .where(
      and(
        eq(templatePartials.workspaceId, ctx.workspaceId),
        eq(templatePartials.name, name),
        eq(templatePartials.isCurrent, true),
      ),
    )
    .limit(1);
  return row;
}

/**
 * Current version of every partial in the workspace that a render may use. A partial that names
 * a component whose markup toggle is off is left out — the page then fails like it would for an
 * unknown name (visible), never silently blank.
 */
export async function loadCurrentPartials(db: Db, workspaceId: string): Promise<PartialRow[]> {
  const [rows, flags] = await Promise.all([
    loadStoredPartials(db, workspaceId),
    loadComponentMarkupFlags(db, workspaceId),
  ]);
  return rows.filter((r) => flags.get(r.name) !== false);
}

/** Every stored current partial, toggle or not — for the editor and the list */
async function loadStoredPartials(db: Db, workspaceId: string): Promise<PartialRow[]> {
  return db
    .select()
    .from(templatePartials)
    .where(and(eq(templatePartials.workspaceId, workspaceId), eq(templatePartials.isCurrent, true)));
}

/** Stylesheet of the partials a render touched — appended after the page template's css */
export function usedPartialCss(rows: PartialRow[], used: ReadonlySet<string>): string {
  return rows
    .filter((p) => used.has(p.name) && p.css.trim() !== "")
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => `/* partial ${p.name} v${p.version} */\n${p.css}`)
    .join("\n");
}

/**
 * Name → source map for the renderer. `edit` picks the marked variant, falling back to the
 * published source for partials that have none.
 */
export function partialSourceMap(rows: PartialRow[], edit = false): PartialSource {
  return new Map(rows.map((r) => [r.name, edit && r.liquidEdit ? r.liquidEdit : r.liquid]));
}

export const partialSave = defineCommand({
  name: "template.partial_save",
  resource: "template_partial",
  input: z.object({
    name: partialName,
    liquid: z.string().max(SOURCE_MAX),
    /** Authoring variant with `data-blk`/`data-prop` markers; empty = same as liquid */
    liquidEdit: z.string().max(SOURCE_MAX).optional(),
    /** style.css (40-IMPL) — if omitted, the previous version's css is kept */
    css: z.string().max(SOURCE_MAX).optional(),
    /** if omitted, the previous version's js is kept — passing a change requires template_script */
    js: z.string().max(SOURCE_MAX).optional(),
  }),
  permission: () => ({ action: PermissionAction.Update, subject: SystemSubject.Templates }),
  async execute(input, ctx) {
    const flags = await loadComponentMarkupFlags(ctx.db, ctx.workspaceId);
    if (flags.get(input.name) === false) throw new ComponentMarkupDisabledError(input.name);
    const current = await getCurrentPartial(ctx, input.name);
    let js = current?.js ?? "";
    if (input.js !== undefined && input.js !== js) {
      await assertPermissionInExecute(ctx, {
        action: PermissionAction.Update,
        subject: SystemSubject.TemplateScript,
      });
      js = input.js;
    }
    const version = (current?.version ?? 0) + 1;
    await ctx.db
      .update(templatePartials)
      .set({ isCurrent: false })
      .where(
        and(
          eq(templatePartials.workspaceId, ctx.workspaceId),
          eq(templatePartials.name, input.name),
          eq(templatePartials.isCurrent, true),
        ),
      );
    const [row] = await ctx.db
      .insert(templatePartials)
      .values({
        workspaceId: ctx.workspaceId,
        name: input.name,
        version,
        liquid: input.liquid,
        liquidEdit: input.liquidEdit ?? "",
        css: input.css ?? current?.css ?? "",
        js,
        isCurrent: true,
      })
      .returning();
    return row!;
  },
  resourceId: (_i, o) => o.id,
  auditPayload: (i, o) => ({ name: i.name, version: o.version, jsChanged: i.js !== undefined }),
});

/** Make a saved version current again — same affordance as template versions (40-IMPL) */
export const partialSetCurrent = defineCommand({
  name: "template.partial_set_current",
  resource: "template_partial",
  input: z.object({ name: partialName, version: z.number().int().positive() }),
  permission: () => ({ action: PermissionAction.Update, subject: SystemSubject.Templates }),
  async execute(input, ctx) {
    const flags = await loadComponentMarkupFlags(ctx.db, ctx.workspaceId);
    if (flags.get(input.name) === false) throw new ComponentMarkupDisabledError(input.name);
    const [target] = await ctx.db
      .select()
      .from(templatePartials)
      .where(
        and(
          eq(templatePartials.workspaceId, ctx.workspaceId),
          eq(templatePartials.name, input.name),
          eq(templatePartials.version, input.version),
        ),
      )
      .limit(1);
    if (!target) throw new NotFoundError(`Partial '${input.name}' v${input.version} not found`);
    await ctx.db
      .update(templatePartials)
      .set({ isCurrent: false })
      .where(
        and(
          eq(templatePartials.workspaceId, ctx.workspaceId),
          eq(templatePartials.name, input.name),
          eq(templatePartials.isCurrent, true),
        ),
      );
    await ctx.db.update(templatePartials).set({ isCurrent: true }).where(eq(templatePartials.id, target.id));
    return target;
  },
  resourceId: (i) => i.name,
  auditPayload: (i) => ({ name: i.name, version: i.version }),
});

export const partialGet = defineCommand({
  name: "template.partial_get",
  resource: "template_partial",
  skipAudit: true,
  input: z.object({ name: partialName }),
  permission: () => ({ action: PermissionAction.Read, subject: SystemSubject.Templates }),
  async execute(input, ctx) {
    const current = await getCurrentPartial(ctx, input.name);
    if (!current) throw new NotFoundError(`Partial '${input.name}' not found`);
    const versions = await ctx.db
      .select({
        id: templatePartials.id,
        version: templatePartials.version,
        isCurrent: templatePartials.isCurrent,
        createdAt: templatePartials.createdAt,
      })
      .from(templatePartials)
      .where(and(eq(templatePartials.workspaceId, ctx.workspaceId), eq(templatePartials.name, input.name)))
      .orderBy(desc(templatePartials.version));
    // For the script.js tab lock — the UI shows it, the API rejects saves (same as templateGet)
    const canEditScript = await canActor(ctx, {
      action: PermissionAction.Update,
      subject: SystemSubject.TemplateScript,
    });
    return { current, versions, canEditScript };
  },
});

export const partialList = defineCommand({
  name: "template.partial_list",
  resource: "template_partial",
  skipAudit: true,
  input: z.object({}).default({}),
  permission: () => ({ action: PermissionAction.Read, subject: SystemSubject.Templates }),
  async execute(_input, ctx) {
    // Lists every stored partial, including a component's whose toggle is off (the editor needs
    // to see it) — `enabled` says whether a render can reach it.
    const [rows, flags] = await Promise.all([
      loadStoredPartials(ctx.db, ctx.workspaceId),
      loadComponentMarkupFlags(ctx.db, ctx.workspaceId),
    ]);
    return rows
      .map((r) => ({
        name: r.name,
        version: r.version,
        hasEditVariant: r.liquidEdit !== "",
        hasCss: r.css.trim() !== "",
        hasJs: r.js.trim() !== "",
        /** true when the name is a component uid — this partial is that component's markup */
        component: flags.has(r.name),
        enabled: flags.get(r.name) !== false,
        updatedAt: r.createdAt,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  },
});

/** Removes every version — pages whose template still renders the name fail at render time (visible, not silent) */
export const partialDelete = defineCommand({
  name: "template.partial_delete",
  resource: "template_partial",
  input: z.object({ name: partialName }),
  permission: () => ({ action: PermissionAction.Delete, subject: SystemSubject.Templates }),
  async execute(input, ctx) {
    const current = await getCurrentPartial(ctx, input.name);
    if (!current) throw new NotFoundError(`Partial '${input.name}' not found`);
    const deleted = await ctx.db
      .delete(templatePartials)
      .where(and(eq(templatePartials.workspaceId, ctx.workspaceId), eq(templatePartials.name, input.name)))
      .returning({ id: templatePartials.id });
    return { name: input.name, deleted: deleted.length };
  },
  resourceId: (i) => i.name,
  auditPayload: (i, o) => ({ name: i.name, deleted: o.deleted }),
});

/**
 * Render one partial with a block value (`blk`) — the authoring canvas re-draws a single block
 * this way, and the developer mode previews unsaved source. Nested `{% render %}` resolves against
 * the workspace's current partials.
 */
export const partialRender = defineCommand({
  name: "template.partial_render",
  resource: "template_partial",
  skipAudit: true,
  input: z.object({
    name: partialName,
    /** Block value — becomes `blk` in the partial's scope */
    values: z.record(z.unknown()).default({}),
    /** Render the `data-blk`/`data-prop` marked variant */
    edit: z.boolean().optional(),
    /** Unsaved source to render instead of the stored current version */
    liquid: z.string().max(SOURCE_MAX).optional(),
    /** Unsaved stylesheet — echoed back in `css` ahead of the nested partials' css (40-IMPL) */
    css: z.string().max(SOURCE_MAX).optional(),
  }),
  permission: () => ({ action: PermissionAction.Read, subject: SystemSubject.Templates }),
  async execute(input, ctx) {
    // The editor previews a component whose toggle may still be off — read every stored partial
    const rows = await loadStoredPartials(ctx.db, ctx.workspaceId);
    const partials = partialSourceMap(rows, input.edit === true);
    const source = input.liquid ?? partials.get(input.name);
    if (source === undefined) throw new NotFoundError(`Partial '${input.name}' not found`);
    const used = new Set<string>();
    const html = await renderLiquid({
      liquid: source,
      scope: { blk: input.values },
      storage: ctx.services.storage,
      partials,
      onPartialUsed: (n) => used.add(n),
    });
    const own = input.css ?? rows.find((r) => r.name === input.name)?.css ?? "";
    used.delete(input.name);
    const css = [own, usedPartialCss(rows, used)].filter((c) => c.trim() !== "").join("\n");
    return { html, css };
  },
});
