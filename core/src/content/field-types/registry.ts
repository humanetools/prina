/**
 * Field type registry (T1.2)
 * Adding a type = implementing this interface + one register call.
 * Each handler owns its def schema, value validation, JSON Schema derivation, text extraction, and completeness check.
 */
import type { ZodType } from "zod";
import type { ContentTypeDefinition, FieldDef } from "@prina/shared";
import { FieldType } from "@prina/shared";

export type JsonSchemaObject = Record<string, unknown>;

/** Context for looking up component definitions and the registry at compile time */
export interface CompileCtx {
  registry: FieldTypeRegistry;
  resolveComponent(uid: string): ContentTypeDefinition | undefined;
}

/** Async value validation context, e.g. DB reference checks (per-handler service injection) */
export interface ValueValidationCtx {
  workspaceId: string;
  /** Check entry ids exist (relation) — target type uid + id list → set of existing ids */
  findExistingEntryIds(targetTypeUid: string, ids: string[]): Promise<Set<string>>;
  /** Check asset ids exist (media) */
  findExistingAssetIds(ids: string[]): Promise<Set<string>>;
}

export interface FieldTypeHandler<D extends FieldDef = FieldDef> {
  type: FieldType;
  /** Validation schema for the field definition itself (CTB input) */
  defSchema: ZodType<unknown>;
  /** JSON Schema derivation for values — shared source for REST validation, OpenAPI, MCP tools (T1.3) */
  toJsonSchema(def: D, ctx: CompileCtx): JsonSchemaObject;
  /** Validation not expressible in JSON Schema (DB referential integrity etc.). Returns array of error messages */
  validateValue?(def: D, value: unknown, ctx: ValueValidationCtx): Promise<string[]>;
  /** Text extraction for search indexing (T1.8) */
  extractText?(def: D, value: unknown): string;
  /** Completeness (T1.7): condition for a value to count as "filled". Default = not null/undefined/''/[] */
  isFilled?(def: D, value: unknown): boolean;
  /** Reason for incompleteness (e.g. "2 images missing"). null means default wording */
  missingReason?(def: D, value: unknown): string | null;
  /** Indexing hint: generated column expression etc. (§2.1 extension point) */
  indexHint?(def: D): string | null;
  /** DAM usage tracking (T4.3): collect asset ids referenced by the value */
  extractAssetIds?(def: D, value: unknown): string[];
}

export class FieldTypeRegistry {
  private handlers = new Map<FieldType, FieldTypeHandler>();

  register(handler: FieldTypeHandler<never>): void {
    this.handlers.set(handler.type, handler as unknown as FieldTypeHandler);
  }

  get(type: FieldType | string): FieldTypeHandler {
    const h = this.handlers.get(type as FieldType);
    if (!h) throw new Error(`Unregistered field type: ${type}`);
    return h;
  }

  has(type: string): boolean {
    return this.handlers.has(type as FieldType);
  }

  list(): FieldTypeHandler[] {
    return [...this.handlers.values()];
  }
}

/** Default filled check */
export function defaultIsFilled(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}
