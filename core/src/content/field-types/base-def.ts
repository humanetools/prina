import { z } from "zod";

/** Field API key: lowercase-start snake/camel allowed, JSONB key & GraphQL compatible */
export const fieldNameSchema = z
  .string()
  .regex(/^[a-z][a-zA-Z0-9_]{0,63}$/, "Field name must start with a lowercase letter and contain only letters, digits or _");

/** Common properties for all field definitions (kept in sync with BaseFieldDef) */
export const baseDefShape = {
  name: fieldNameSchema,
  label: z.string().max(200).optional(),
  description: z.string().max(2000).optional(),
  required: z.boolean().optional(),
  localized: z.boolean().optional(),
  completenessWeight: z.number().positive().max(100).optional(),
};
