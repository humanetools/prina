/**
 * Command pipeline (T1.4): input validation → permission hook → execute (transaction) → audit record.
 * Every feature exists as a command on top of this pipeline (MCP-First, absolute principle 2).
 */
import type { ZodType, ZodTypeDef } from "zod";
import { auditLog } from "../db/schema/index.js";
import { ForbiddenError, ValidationError } from "../lib/errors.js";
import type { CommandCtx, PermissionRequest } from "./context.js";

export interface CommandDef<I, O> {
  /** e.g. entry.create — also recorded as the audit log action */
  name: string;
  /** Audit log resource_type */
  resource: string;
  /** Unpack the Input type parameter so schemas with .default() also infer to the output type (I) */
  input: ZodType<I, ZodTypeDef, unknown>;
  /**
   * Permission declaration (T2.2) — no permission check when undeclared (public reads, etc.).
   * Permission checks are enforced here (the storage API), not by hiding UI (absolute principle 6).
   */
  permission?(input: I): PermissionRequest | null;
  execute(input: I, ctx: CommandCtx): Promise<O>;
  /** Audit payload (default: no input summary) */
  auditPayload?(input: I, output: O): Record<string, unknown>;
  resourceId?(input: I, output: O): string | undefined;
  /** Read commands skip audit recording */
  skipAudit?: boolean;
}

export interface Command<I, O> extends CommandDef<I, O> {
  run(rawInput: unknown, ctx: CommandCtx): Promise<O>;
}

export function defineCommand<I, O>(def: CommandDef<I, O>): Command<I, O> {
  return {
    ...def,
    async run(rawInput: unknown, ctx: CommandCtx): Promise<O> {
      const parsed = def.input.safeParse(rawInput);
      if (!parsed.success) {
        throw new ValidationError(`${def.name}: input is not valid`, {
          issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
        });
      }
      const input = parsed.data;

      const permission = def.permission?.(input) ?? null;

      // Permission denials are audited wherever they originate (permission hook, transition guard) (T2.2/T6.2)
      const recordDenied = async (err: ForbiddenError) => {
        await ctx.db.insert(auditLog).values({
          workspaceId: ctx.workspaceId || null,
          actorType: ctx.actor.type,
          actorId: ctx.actor.id ?? null,
          actorLabel: ctx.actor.label ?? null,
          action: `${def.name}.denied`,
          resourceType: def.resource,
          resourceId: null,
          payload: { reason: err.message, permission },
        });
      };

      try {
        await ctx.services.authorize(
          { name: def.name, resource: def.resource, permission },
          input,
          ctx,
        );

        // Execute and audit record in one transaction — so no change can exist without an audit entry
        if (def.skipAudit) {
          return await def.execute(input, ctx);
        }
        return await ctx.db.transaction(async (tx) => {
          const txCtx: CommandCtx = { ...ctx, db: tx as unknown as CommandCtx["db"] };
          const output = await def.execute(input, txCtx);
          await tx.insert(auditLog).values({
            workspaceId: ctx.workspaceId || null,
            actorType: ctx.actor.type,
            actorId: ctx.actor.id ?? null,
            actorLabel: ctx.actor.label ?? null,
            action: def.name,
            resourceType: def.resource,
            resourceId: def.resourceId?.(input, output) ?? null,
            payload: def.auditPayload?.(input, output) ?? null,
          });
          return output;
        });
      } catch (err) {
        // Denials inside execute must be recorded after the transaction rollback so they are not lost
        if (err instanceof ForbiddenError) await recordDenied(err);
        throw err;
      }
    },
  };
}
