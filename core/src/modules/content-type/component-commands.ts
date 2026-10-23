/** Component CRUD commands — same pipeline as content types */
import { z } from "zod";
import { and, asc, eq } from "drizzle-orm";
import { PermissionAction, SystemSubject } from "@prina/shared";
import { components } from "../../db/schema/index.js";
import { defineCommand } from "../../commands/define.js";
import { validateDefinition } from "../../content/definition-validator.js";
import { ConflictError, NotFoundError } from "../../lib/errors.js";
import type { CommandCtx } from "../../commands/context.js";

const uidSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_.-]{1,63}$/, "Invalid component uid format");

const componentPermission = (action: string) => () => ({
  action,
  subject: SystemSubject.Components,
});

async function getComponent(ctx: Pick<CommandCtx, "db" | "workspaceId">, uid: string) {
  const [row] = await ctx.db
    .select()
    .from(components)
    .where(and(eq(components.workspaceId, ctx.workspaceId), eq(components.uid, uid)))
    .limit(1);
  if (!row) throw new NotFoundError(`Component '${uid}' not found`);
  return row;
}

export const componentCreate = defineCommand({
  name: "component.create",
  resource: "component",
  input: z.object({
    uid: uidSchema,
    name: z.string().min(1).max(200),
    definition: z.unknown(),
  }),
  permission: componentPermission(PermissionAction.Create),
  async execute(input, ctx) {
    const definition = validateDefinition(ctx.services.registry, input.definition, {
      isComponent: true,
    });
    const [existing] = await ctx.db
      .select({ id: components.id })
      .from(components)
      .where(and(eq(components.workspaceId, ctx.workspaceId), eq(components.uid, input.uid)))
      .limit(1);
    if (existing) throw new ConflictError(`Component '${input.uid}' already exists`);
    const [row] = await ctx.db
      .insert(components)
      .values({
        workspaceId: ctx.workspaceId,
        uid: input.uid,
        name: input.name,
        definition,
      })
      .returning();
    return row!;
  },
  resourceId: (_i, o) => o.id,
  auditPayload: (i) => ({ uid: i.uid }),
});

export const componentUpdate = defineCommand({
  name: "component.update",
  resource: "component",
  input: z.object({
    uid: uidSchema,
    name: z.string().min(1).max(200).optional(),
    definition: z.unknown().optional(),
  }),
  permission: componentPermission(PermissionAction.Update),
  async execute(input, ctx) {
    const current = await getComponent(ctx, input.uid);
    const patch: Partial<typeof components.$inferInsert> = { updatedAt: new Date() };
    if (input.name !== undefined) patch.name = input.name;
    if (input.definition !== undefined) {
      patch.definition = validateDefinition(ctx.services.registry, input.definition, {
        isComponent: true,
      });
      patch.version = current.version + 1;
      // Components are inlined into many types' compiled schemas — invalidate the whole workspace
      ctx.services.schemas.invalidateWorkspace(ctx.workspaceId);
    }
    const [row] = await ctx.db
      .update(components)
      .set(patch)
      .where(eq(components.id, current.id))
      .returning();
    return row!;
  },
  resourceId: (_i, o) => o.id,
  auditPayload: (i) => ({ uid: i.uid, definitionChanged: i.definition !== undefined }),
});

export const componentDelete = defineCommand({
  name: "component.delete",
  resource: "component",
  input: z.object({ uid: uidSchema }),
  permission: componentPermission(PermissionAction.Delete),
  async execute(input, ctx) {
    const current = await getComponent(ctx, input.uid);
    await ctx.db.delete(components).where(eq(components.id, current.id));
    ctx.services.schemas.invalidateWorkspace(ctx.workspaceId);
    return { id: current.id, uid: current.uid };
  },
  resourceId: (_i, o) => o.id,
  auditPayload: (i) => ({ uid: i.uid }),
});

export const componentList = defineCommand({
  name: "component.list",
  resource: "component",
  skipAudit: true,
  input: z.object({}).default({}),
  permission: componentPermission(PermissionAction.Read),
  async execute(_input, ctx) {
    return ctx.db
      .select()
      .from(components)
      .where(eq(components.workspaceId, ctx.workspaceId))
      .orderBy(asc(components.uid));
  },
});
