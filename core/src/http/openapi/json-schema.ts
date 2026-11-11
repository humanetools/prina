/** zod → JSON Schema for an OpenAPI 3.1 document (draft-7 keywords: numeric exclusive bounds, `const`) */
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ZodTypeAny } from "zod";

export function toJsonSchema(schema: ZodTypeAny): Record<string, unknown> {
  const { $schema: _dialect, ...rest } = zodToJsonSchema(schema, {
    $refStrategy: "none",
    target: "jsonSchema7",
    effectStrategy: "input",
  }) as Record<string, unknown>;
  return rest;
}
