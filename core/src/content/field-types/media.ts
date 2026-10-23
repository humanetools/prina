/**
 * media field (T1.2, §0.12) — value item = asset id (uuid) or {id, alt} with a per-usage
 * alt override. Every consumer must normalize through toMediaRef(s); never assume strings.
 */
import { z } from "zod";
import { FieldType } from "@prina/shared";
import type { MediaFieldDef } from "@prina/shared";
import { baseDefShape } from "./base-def.js";
import type { FieldTypeHandler } from "./registry.js";

const UUID = { type: "string", format: "uuid" };
/** Per-usage override shape — alt "" = decorative, null/absent = inherit the asset's alt */
const REF_OBJECT = {
  type: "object",
  properties: { id: UUID, alt: { type: ["string", "null"], maxLength: 1000 } },
  required: ["id"],
  additionalProperties: false,
};
const REF = { anyOf: [UUID, REF_OBJECT] };

export interface MediaRef {
  id: string;
  /** Usage-level override; null/undefined = inherit the asset alt */
  alt: string | null | undefined;
}

/** Accepts "uuid", {id, alt}, or garbage (→ null) */
export function toMediaRef(value: unknown): MediaRef | null {
  if (typeof value === "string") return value ? { id: value, alt: undefined } : null;
  if (value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string") {
    const v = value as { id: string; alt?: string | null };
    return { id: v.id, alt: v.alt };
  }
  return null;
}

/** Normalized refs of a media field value, single or multiple, either item shape */
export function toMediaRefs(def: Pick<MediaFieldDef, "multiple">, value: unknown): MediaRef[] {
  if (value === null || value === undefined) return [];
  const items = def.multiple ? (Array.isArray(value) ? value : []) : [value];
  return items.map(toMediaRef).filter((r): r is MediaRef => r !== null);
}

export const mediaField: FieldTypeHandler<MediaFieldDef> = {
  type: FieldType.Media,
  defSchema: z
    .object({
      ...baseDefShape,
      type: z.literal(FieldType.Media),
      multiple: z.boolean().optional(),
      min: z.number().int().nonnegative().optional(),
      max: z.number().int().positive().optional(),
      allowedMimeTypes: z.array(z.string()).optional(),
      /** a11y: show the alt-text input in Content Manager (asset alt + per-usage override) */
      altText: z.boolean().optional(),
    })
    .refine((d) => d.multiple || (d.min === undefined && d.max === undefined), {
      message: "min/max apply only to multiple media fields",
    }),
  toJsonSchema(def) {
    if (!def.multiple) return { ...REF };
    const s: Record<string, unknown> = { type: "array", items: REF };
    // min is used only as a completeness (T1.7) criterion, not to block saving — allow partial saves in drafts
    if (def.max !== undefined) s.maxItems = def.max;
    return s;
  },
  async validateValue(def, value, ctx) {
    if (value === null || value === undefined) return [];
    const ids = toMediaRefs(def, value).map((r) => r.id);
    if (ids.length === 0) return [];
    const existing = await ctx.findExistingAssetIds(ids);
    return ids
      .filter((id) => !existing.has(id))
      .map((id) => `${def.name}: asset ${id} does not exist`);
  },
  isFilled(def, value) {
    if (value === null || value === undefined) return false;
    if (!def.multiple) return toMediaRefs(def, value).length > 0;
    return toMediaRefs(def, value).length >= (def.min ?? 1);
  },
  missingReason(def, value) {
    if (!def.multiple || def.min === undefined) return null;
    const count = toMediaRefs(def, value).length;
    if (count >= def.min) return null;
    return `${def.min - count} more image(s) needed`;
  },
  extractAssetIds(def, value) {
    return toMediaRefs(def, value).map((r) => r.id);
  },
};
