/** Primitive value field types: text / number / boolean / date / enum / json (T1.2) */
import { z } from "zod";
import { FieldType } from "@prina/shared";
import type {
  TextFieldDef,
  NumberFieldDef,
  BooleanFieldDef,
  DateFieldDef,
  EnumFieldDef,
  JsonFieldDef,
} from "@prina/shared";
import { baseDefShape } from "./base-def.js";
import type { FieldTypeHandler } from "./registry.js";

export const textField: FieldTypeHandler<TextFieldDef> = {
  type: FieldType.Text,
  defSchema: z.object({
    ...baseDefShape,
    type: z.literal(FieldType.Text),
    minLength: z.number().int().nonnegative().optional(),
    maxLength: z.number().int().positive().optional(),
    pattern: z.string().optional(),
    multiline: z.boolean().optional(),
    unique: z.boolean().optional(),
  }),
  toJsonSchema(def) {
    const s: Record<string, unknown> = { type: "string" };
    if (def.minLength !== undefined) s.minLength = def.minLength;
    if (def.maxLength !== undefined) s.maxLength = def.maxLength;
    if (def.pattern !== undefined) s.pattern = def.pattern;
    return s;
  },
  extractText: (_def, value) => (typeof value === "string" ? value : ""),
  indexHint: (def) =>
    def.unique ? `values->>'${def.name}' (unique generated column candidate)` : null,
};

export const numberField: FieldTypeHandler<NumberFieldDef> = {
  type: FieldType.Number,
  defSchema: z.object({
    ...baseDefShape,
    type: z.literal(FieldType.Number),
    min: z.number().optional(),
    max: z.number().optional(),
    integer: z.boolean().optional(),
  }),
  toJsonSchema(def) {
    const s: Record<string, unknown> = { type: def.integer ? "integer" : "number" };
    if (def.min !== undefined) s.minimum = def.min;
    if (def.max !== undefined) s.maximum = def.max;
    return s;
  },
};

export const booleanField: FieldTypeHandler<BooleanFieldDef> = {
  type: FieldType.Boolean,
  defSchema: z.object({ ...baseDefShape, type: z.literal(FieldType.Boolean) }),
  toJsonSchema: () => ({ type: "boolean" }),
  /** For boolean, false is also a valid value — only null/undefined count as unfilled */
  isFilled: (_def, value) => value !== null && value !== undefined,
};

export const dateField: FieldTypeHandler<DateFieldDef> = {
  type: FieldType.Date,
  defSchema: z.object({
    ...baseDefShape,
    type: z.literal(FieldType.Date),
    withTime: z.boolean().optional(),
  }),
  toJsonSchema: (def) => ({
    type: "string",
    format: def.withTime ? "date-time" : "date",
  }),
};

export const enumField: FieldTypeHandler<EnumFieldDef> = {
  type: FieldType.Enum,
  defSchema: z.object({
    ...baseDefShape,
    type: z.literal(FieldType.Enum),
    options: z.array(z.string().min(1)).min(1),
  }),
  toJsonSchema: (def) => ({ type: "string", enum: def.options }),
};

export const jsonField: FieldTypeHandler<JsonFieldDef> = {
  type: FieldType.Json,
  defSchema: z.object({ ...baseDefShape, type: z.literal(FieldType.Json) }),
  /** Arbitrary JSON — no schema constraints */
  toJsonSchema: () => ({}),
};
