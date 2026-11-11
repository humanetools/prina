/**
 * Schema pipeline (T1.3) — compiler for the single schema source (absolute principle 3).
 * Content type definition (JSONB) → JSON Schema → (1) value validation (Ajv) (2) OpenAPI (3) MCP tool (Phase 6)
 *
 * [decision] "Presence enforcement" of required fields applies at publish transition, not at save.
 * Drafts must allow incomplete saves (the completeness score T1.7 represents that state);
 * save-time validation only enforces "the shape of incoming values". The publish gate lives in entry.transition.
 */
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
import addFormatsModule from "ajv-formats";

// Fix up CJS default export under NodeNext module resolution
const addFormatsAny = addFormatsModule as unknown as
  | ((ajv: Ajv2020) => void)
  | { default: (ajv: Ajv2020) => void };
const addFormats =
  typeof addFormatsAny === "function" ? addFormatsAny : addFormatsAny.default;
import type { ContentTypeDefinition } from "@prina/shared";
import type { CompileCtx, JsonSchemaObject } from "./field-types/registry.js";
import { FieldTypeRegistry } from "./field-types/registry.js";
import { ValidationError } from "../lib/errors.js";

/** Definition → JSON Schema of the values object. Also used for recursive component compilation */
export function compileDefinitionToObjectSchema(
  definition: ContentTypeDefinition,
  ctx: CompileCtx,
): JsonSchemaObject {
  const properties: Record<string, JsonSchemaObject> = {};
  for (const field of definition.fields) {
    const handler = ctx.registry.get(field.type);
    const valueSchema = handler.toJsonSchema(field, ctx);
    // Every field allows null — "empty" is a valid state in drafts (see decision above)
    properties[field.name] =
      Object.keys(valueSchema).length === 0
        ? {}
        : { anyOf: [valueSchema, { type: "null" }] };
  }
  return {
    type: "object",
    properties,
    additionalProperties: false, // Reject fields not in the definition — block data outside the schema
  };
}

export interface CompiledSchema {
  jsonSchema: JsonSchemaObject;
  validate: ValidateFunction;
}

/**
 * Compile result cache — key includes content_types.version, so type changes invalidate naturally.
 * On component changes, invalidateWorkspace() invalidates the whole workspace at once.
 */
export class SchemaCache {
  private ajv: Ajv2020;
  private cache = new Map<string, CompiledSchema>();

  constructor(private registry: FieldTypeRegistry) {
    this.ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(this.ajv);
  }

  getOrCompile(
    workspaceId: string,
    typeId: string,
    typeVersion: number,
    definition: ContentTypeDefinition,
    resolveComponent: CompileCtx["resolveComponent"],
  ): CompiledSchema {
    const key = `${workspaceId}:${typeId}:v${typeVersion}`;
    const hit = this.cache.get(key);
    if (hit) return hit;

    const jsonSchema = compileDefinitionToObjectSchema(definition, {
      registry: this.registry,
      resolveComponent,
    });
    const validate = this.ajv.compile(jsonSchema as object);
    const compiled = { jsonSchema, validate };
    this.cache.set(key, compiled);
    return compiled;
  }

  invalidateWorkspace(workspaceId: string): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${workspaceId}:`)) this.cache.delete(key);
    }
  }
}

/** Ajv errors → list of human-readable messages */
export function formatAjvErrors(validate: ValidateFunction): string[] {
  return (validate.errors ?? []).map((e) => {
    const path = e.instancePath.replace(/^\//, "").replace(/\//g, ".") || "(root)";
    return `${path}: ${e.message ?? "invalid"}`;
  });
}

/** Validate values against the compiled schema; ValidationError on failure */
export function assertValuesAgainstSchema(
  compiled: CompiledSchema,
  values: Record<string, unknown>,
): void {
  if (!compiled.validate(values)) {
    throw new ValidationError("Values violate the content type schema", {
      issues: formatAjvErrors(compiled.validate),
    });
  }
}
