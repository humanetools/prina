import type { ContentTypeKind, FieldType } from "./enums.js";

/**
 * Content type definition (JSONB) structure — single source of truth for schemas (Absolute Principle 3).
 * JSON Schema → REST validation, OpenAPI, and MCP tool schemas are all derived from this definition.
 */

/** Properties common to all field definitions */
export interface BaseFieldDef {
  /** Field API key (the key in the values JSONB) */
  name: string;
  type: FieldType;
  /** Display name in Admin */
  label?: string;
  description?: string;
  required?: boolean;
  /** Whether the value is independent per locale (document-level i18n, §2.3) */
  localized?: boolean;
  /** Completeness score weight (default 1) */
  completenessWeight?: number;
}

export interface TextFieldDef extends BaseFieldDef {
  type: FieldType.Text;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  /** Single-line/multi-line UI hint */
  multiline?: boolean;
  unique?: boolean;
}

export interface UidFieldDef extends BaseFieldDef {
  type: FieldType.Uid;
  /** Source field to derive the value from — when saved empty, the slug is generated from this field's value */
  targetField?: string;
}

export interface RichtextFieldDef extends BaseFieldDef {
  type: FieldType.Richtext;
}

export interface NumberFieldDef extends BaseFieldDef {
  type: FieldType.Number;
  min?: number;
  max?: number;
  integer?: boolean;
}

export interface BooleanFieldDef extends BaseFieldDef {
  type: FieldType.Boolean;
}

export interface DateFieldDef extends BaseFieldDef {
  type: FieldType.Date;
  /** date | datetime */
  withTime?: boolean;
}

export interface EnumFieldDef extends BaseFieldDef {
  type: FieldType.Enum;
  options: string[];
}

export interface JsonFieldDef extends BaseFieldDef {
  type: FieldType.Json;
}

export interface MediaFieldDef extends BaseFieldDef {
  type: FieldType.Media;
  multiple?: boolean;
  /** Min/max count when multiple — basis for completeness messages like "2 images missing" */
  min?: number;
  max?: number;
  allowedMimeTypes?: string[];
  /** Surface an alt-text input next to the picker in Content Manager (a11y, WCAG 1.1.1) */
  altText?: boolean;
}

export interface RelationFieldDef extends BaseFieldDef {
  type: FieldType.Relation;
  /** Target content type uid */
  target: string;
  relationKind: "oneToOne" | "oneToMany" | "manyToOne" | "manyToMany";
  /** KG placeholder (Absolute Principle 5): semantic predicate — v1 only stores it; the feature lands in Phase 9 */
  predicate?: string;
  /** Inverse predicate — when writeInverse is on, emitted under this name in the target entry's JSON-LD */
  inversePredicate?: string;
  writeInverse?: boolean;
}

export interface ComponentFieldDef extends BaseFieldDef {
  type: FieldType.Component;
  /** Target component uid */
  component: string;
  repeatable?: boolean;
  min?: number;
  max?: number;
}

export interface DynamicZoneFieldDef extends BaseFieldDef {
  type: FieldType.DynamicZone;
  /** Allowed component uid list */
  components: string[];
  min?: number;
  max?: number;
}

export interface VariantAxisFieldDef extends BaseFieldDef {
  type: FieldType.VariantAxis;
  /** Axis definitions: [{ name: "Color", options: ["Red","Blue"] }] (§2.8) */
  axes: Array<{ name: string; options: string[] }>;
}

export type FieldDef =
  | TextFieldDef
  | UidFieldDef
  | RichtextFieldDef
  | NumberFieldDef
  | BooleanFieldDef
  | DateFieldDef
  | EnumFieldDef
  | JsonFieldDef
  | MediaFieldDef
  | RelationFieldDef
  | ComponentFieldDef
  | DynamicZoneFieldDef
  | VariantAxisFieldDef;

/** Full structure of the content_types.definition JSONB */
export interface ContentTypeDefinition {
  fields: FieldDef[];
  /** Default display field on list screens */
  displayField?: string;
  /** Edition namespace (opaque to core) — EE features keep per-type flags here, e.g. ee.chatbot.excluded */
  ee?: Record<string, unknown>;
}

export interface ContentTypeInfo {
  uid: string;
  kind: ContentTypeKind;
  name: string;
  description?: string;
  /** KG placeholder (Absolute Principle 5): schema.org type mapping — v1 only stores it */
  schemaOrgType?: string | null;
  definition: ContentTypeDefinition;
  version: number;
}

/** Completeness score calculation result (T1.7) */
export interface CompletenessResult {
  /** 0~100 */
  score: number;
  missing: Array<{ field: string; label?: string; reason: string }>;
}

/**
 * Per-entry SEO record (entries.seo JSONB, §0.11 SEO axis).
 * Lives outside `values` — the compiled entry schema rejects unknown keys, and SEO
 * must stay out of search_text/completeness/MCP tool payloads by default.
 * All keys optional; a null column means the panel was never touched.
 */
export interface EntrySeo {
  metaTitle?: string;
  metaDescription?: string;
  /** Absolute URL override — wins over the type's urlPattern resolution */
  canonical?: string;
  /** DAM asset id for og:image */
  ogImage?: string;
  ogTitle?: string;
  ogDescription?: string;
  noindex?: boolean;
}

/**
 * AI-draft provenance (entries.ai_draft JSONB) — set when AI wrote this entry's content
 * (locale translation, IMPL-ai-locale-translation) and cleared the moment a human saves
 * or transitions the entry ("reviewed" is defined by those existing actions, not a button).
 */
export interface EntryAiDraft {
  /** translation = locale draft from a sibling; assistant = written via the admin AI assistant */
  kind: "translation" | "assistant";
  /** Entry the translation was made from (translation kind only) */
  sourceEntryId?: string;
  sourceLocale?: string;
  model: string;
  createdAt: string;
  /** Field names the AI wrote (the rest were copied/untouched) */
  fields: string[];
}

/** Per-type SEO configuration (content_types.options.seo) */
export interface SeoTypeOptions {
  enabled: boolean;
  /**
   * Public URL pattern with {token} placeholders resolved from entry values,
   * e.g. "/products/{slug}". Also accepts {locale}, {id}, {documentId}.
   */
  urlPattern?: string;
  /**
   * Absolute pattern pointing at an external original, for syndicated/republished
   * collections — e.g. "https://origin.example.com/posts/{slug}". When it resolves,
   * it becomes the emitted canonical and the entry drops out of this site's sitemap
   * (a sitemap must list canonical URLs only).
   */
  externalCanonicalPattern?: string;
  /** Block publish while error-severity SEO advisories exist (default: warn only) */
  strictPublish?: boolean;
  sitemap?: {
    include: boolean;
    priority?: number;
    changefreq?: string;
  };
}

/** Workspace-global SEO settings (workspaces.settings.seo) */
export interface WorkspaceSeoSettings {
  /** Customer site origin for canonical/sitemap URLs, e.g. "https://example.com" (no trailing slash) */
  siteBaseUrl?: string;
  /** Appended to meta titles, e.g. " | Acme" */
  titleSuffix?: string;
  /** DAM asset id used as og:image fallback */
  defaultOgImage?: string;
  robots?: { extraDisallow?: string[] };
}

/**
 * Media field value item (§0.12 two-level alt): a bare asset uuid, or an object carrying a
 * per-usage alt override. Both shapes coexist forever — writers only produce the object form
 * when an override is actually entered; readers must accept both (normalize via toMediaRefs).
 * Effective alt = usage alt ?? asset alt.
 */
export type MediaRefValue = string | { id: string; alt?: string | null };

/**
 * Preview audit finding (§0.11 WA axis) — structure checks run server-side on rendered HTML,
 * contrast checks client-side in the admin preview. selectorPath is an nth-child chain of
 * element-only indexes ("div:nth-child(1) > img:nth-child(2)") computed identically on both sides.
 */
export interface AuditFinding {
  /** Stable rule id, e.g. "img-alt-missing", "contrast" */
  rule: string;
  /** "manual" = statically undecidable (e.g. text over an image) — verify by hand */
  severity: "error" | "warn" | "manual";
  message: string;
  selectorPath?: string;
  snippet?: string;
}

/** Publish-readiness advisory (SEO/a11y checks) — surfaced in entry detail and the publish gate */
export interface PublishAdvisory {
  /** Stable rule id, e.g. "seo-meta-title-missing" */
  code: string;
  severity: "error" | "warn";
  field?: string;
  message: string;
}
