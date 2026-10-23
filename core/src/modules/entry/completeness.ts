/**
 * Completeness score (T1.7)
 * [decision] On save, cache the score in entries.completeness (for list sorting/filtering);
 * on detail fetch, recompute everything including the missing list (always fresh). Revisit if performance suffers.
 */
import type { CompletenessResult, ContentTypeDefinition } from "@prina/shared";
import type { FieldTypeRegistry } from "../../content/field-types/registry.js";
import { defaultIsFilled } from "../../content/field-types/registry.js";

export function computeCompleteness(
  registry: FieldTypeRegistry,
  definition: ContentTypeDefinition,
  values: Record<string, unknown>,
): CompletenessResult {
  const required = definition.fields.filter((f) => f.required);
  if (required.length === 0) return { score: 100, missing: [] };

  let totalWeight = 0;
  let filledWeight = 0;
  const missing: CompletenessResult["missing"] = [];

  for (const field of required) {
    const weight = field.completenessWeight ?? 1;
    totalWeight += weight;
    const value = values[field.name];
    const handler = registry.get(field.type);
    const filled = handler.isFilled
      ? handler.isFilled(field as never, value)
      : defaultIsFilled(value);
    if (filled) {
      filledWeight += weight;
    } else {
      const reason = handler.missingReason?.(field as never, value) ?? "Value is empty";
      missing.push({ field: field.name, label: field.label, reason });
    }
  }

  return {
    score: Math.round((filledWeight / totalWeight) * 100),
    missing,
  };
}
