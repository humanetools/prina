/** richtext field (T1.2 + T1.8) — value = ProseMirror doc JSON */
import { z } from "zod";
import { FieldType } from "@prina/shared";
import type { RichtextFieldDef } from "@prina/shared";
import { baseDefShape } from "./base-def.js";
import type { FieldTypeHandler } from "./registry.js";
import {
  validateRichtext,
  extractRichtextText,
  extractRichtextAssetIds,
} from "../richtext/index.js";

export const richtextField: FieldTypeHandler<RichtextFieldDef> = {
  type: FieldType.Richtext,
  defSchema: z.object({ ...baseDefShape, type: z.literal(FieldType.Richtext) }),
  /** Structural validation is prosemirror's job — the JSON Schema only constrains the object shape */
  toJsonSchema: () => ({
    type: "object",
    properties: { type: { const: "doc" } },
    required: ["type"],
  }),
  validateValue: async (_def, value) => validateRichtext(value),
  extractText: (_def, value) => extractRichtextText(value),
  isFilled: (_def, value) => extractRichtextText(value).length > 0,
  extractAssetIds: (_def, value) => extractRichtextAssetIds(value),
};
