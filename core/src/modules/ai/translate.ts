/**
 * Locale-translation helpers (IMPL-ai-locale-translation) — pure functions that plan and
 * apply a translation over entry values. The LLM never sees raw structures: richtext is
 * decomposed into text segments here and reassembled in place, so document structure
 * (marks, images, links) cannot be corrupted by the model. Component and dynamic-zone
 * values are walked recursively via their component definitions.
 */
import { FieldType } from "@prina/shared";
import type { ContentTypeDefinition, EntrySeo, FieldDef } from "@prina/shared";

/** Flat map of translatable segments — keys are stable addresses used to write results back */
export type TextSegments = Record<string, string>;
/** Hard character limits per segment key (schema maxLength) — sent to the LLM and enforced after */
export type SegmentLimits = Record<string, number>;

export type ResolveComponent = (uid: string) => ContentTypeDefinition | null;

const SEO_TEXT_KEYS = ["metaTitle", "metaDescription", "ogTitle", "ogDescription"] as const;
/** entries.seo schema hard limits (entrySeoSchema) — advisory soft limits stay human territory */
const SEO_LIMITS: Record<string, number> = {
  metaTitle: 200,
  metaDescription: 500,
  ogTitle: 200,
  ogDescription: 500,
};

/**
 * Top-level fields whose content is language-bound. When the type declares any `localized`
 * flag the flag drives selection (decision ② — the CTB "Localizable" toggle gains its
 * semantics here); otherwise every text-carrying field is translated. Component and
 * dynamic-zone fields count as text-carrying containers and are walked recursively.
 */
const TEXT_CARRYING = new Set<string>([
  FieldType.Text,
  FieldType.Richtext,
  FieldType.Media,
  FieldType.Component,
  FieldType.DynamicZone,
]);

/**
 * Explicit selection from the translate dialog: index-free logical paths of the leaves to
 * translate — "title", "seo.meta_title", "blocks.hero.heading" (dynamic-zone leaves are
 * component-qualified). When given it overrides the localized-flag rule entirely; the flag
 * rule stays the server default for callers that send no selection (MCP, scripts).
 */
export type IncludeSet = Set<string>;

export function translatableFields(
  definition: ContentTypeDefinition,
  include?: IncludeSet,
): FieldDef[] {
  const fields = definition.fields ?? [];
  if (include) {
    const roots = new Set([...include].map((p) => p.split(".")[0]!));
    return fields.filter((f) => TEXT_CARRYING.has(f.type) && roots.has(f.name));
  }
  const anyLocalized = fields.some((f) => f.localized === true);
  return fields.filter(
    (f) => TEXT_CARRYING.has(f.type) && (!anyLocalized || f.localized === true),
  );
}

/** Depth-first walk over ProseMirror doc JSON collecting non-empty text nodes in order */
function walkRichtextTexts(
  node: unknown,
  visit: (holder: { text?: unknown }, text: string) => void,
): void {
  if (!node || typeof node !== "object") return;
  const n = node as { type?: unknown; text?: unknown; content?: unknown };
  if (n.type === "text" && typeof n.text === "string" && n.text.trim() !== "") {
    visit(n, n.text);
  }
  if (Array.isArray(n.content)) for (const child of n.content) walkRichtextTexts(child, visit);
}

/** Media value items may carry per-usage alt overrides ({id, alt}) — those are language-bound */
function mediaItems(value: unknown): Array<{ id: string; alt?: string | null }> {
  const arr = Array.isArray(value) ? value : value ? [value] : [];
  return arr.filter(
    (v): v is { id: string; alt?: string | null } =>
      !!v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string",
  );
}

interface WalkCbs {
  /** Plain text leaf — return a replacement to write it (apply pass) */
  text(key: string, value: string, maxLength?: number): string | undefined;
  /** Richtext text node — mutates the holder in the apply pass */
  richtextText(key: string, holder: { text?: unknown }, value: string): void;
  /** Media alt override — mutates the item in the apply pass */
  mediaAlt(key: string, item: { alt?: string | null }, value: string): void;
}

/**
 * Shared walker for collect/apply. `container` is mutated in the apply pass, so the apply
 * caller hands in a deep clone. Keys: `f.<path>` text, `r.<path>.<i>` richtext node,
 * `a.<path>.<i>` media alt — path segments are field names and array indexes.
 */
function walkFields(
  fields: FieldDef[],
  container: Record<string, unknown>,
  pathPrefix: string,
  logicalPrefix: string,
  resolveComponent: ResolveComponent,
  include: IncludeSet | undefined,
  cbs: WalkCbs,
): boolean {
  let touched = false;
  const included = (logical: string) => !include || include.has(logical);
  for (const f of fields) {
    const value = container[f.name];
    if (value === null || value === undefined) continue;
    const path = pathPrefix ? `${pathPrefix}.${f.name}` : f.name;
    const logical = logicalPrefix ? `${logicalPrefix}.${f.name}` : f.name;
    if (f.type === FieldType.Text) {
      if (typeof value === "string" && value.trim() !== "" && included(logical)) {
        const next = cbs.text(`f.${path}`, value, (f as { maxLength?: number }).maxLength);
        if (next !== undefined) container[f.name] = next;
        touched = true;
      }
    } else if (f.type === FieldType.Richtext) {
      if (!included(logical)) continue;
      let i = 0;
      walkRichtextTexts(value, (holder, text) => {
        cbs.richtextText(`r.${path}.${i++}`, holder, text);
      });
      if (i > 0) touched = true;
    } else if (f.type === FieldType.Media) {
      if (!included(logical)) continue;
      mediaItems(value).forEach((item, i) => {
        // alt "" = decorative (kept), null/absent = inherits the asset alt (nothing to translate)
        if (typeof item.alt === "string" && item.alt.trim() !== "") {
          cbs.mediaAlt(`a.${path}.${i}`, item, item.alt);
          touched = true;
        }
      });
    } else if (f.type === FieldType.Component) {
      const def = resolveComponent((f as { component: string }).component);
      if (!def) continue;
      const items = (f as { repeatable?: boolean }).repeatable
        ? (Array.isArray(value) ? value : [])
        : [value];
      items.forEach((item, i) => {
        if (!item || typeof item !== "object") return;
        const itemPath = (f as { repeatable?: boolean }).repeatable ? `${path}.${i}` : path;
        if (
          walkFields(def.fields ?? [], item as Record<string, unknown>, itemPath, logical, resolveComponent, include, cbs)
        ) {
          touched = true;
        }
      });
    } else if (f.type === FieldType.DynamicZone) {
      if (!Array.isArray(value)) continue;
      value.forEach((item, i) => {
        if (!item || typeof item !== "object") return;
        const uid = (item as { __component?: unknown }).__component;
        const def = typeof uid === "string" ? resolveComponent(uid) : null;
        if (!def || typeof uid !== "string") return;
        // Dynamic-zone leaves are component-qualified: blocks.hero.heading
        if (
          walkFields(def.fields ?? [], item as Record<string, unknown>, `${path}.${i}`, `${logical}.${uid}`, resolveComponent, include, cbs)
        ) {
          touched = true;
        }
      });
    }
  }
  return touched;
}

/** Collect every translatable text segment (with hard length limits) from values + the SEO record */
export function collectSegments(
  definition: ContentTypeDefinition,
  values: Record<string, unknown>,
  seo: EntrySeo | null,
  resolveComponent: ResolveComponent = () => null,
  include?: IncludeSet,
  includeSeo = true,
): { segments: TextSegments; limits: SegmentLimits; fields: string[] } {
  const segments: TextSegments = {};
  const limits: SegmentLimits = {};
  const fields: string[] = [];
  for (const f of translatableFields(definition, include)) {
    const touched = walkFields([f], values, "", "", resolveComponent, include, {
      text(key, value, maxLength) {
        segments[key] = value;
        if (maxLength) limits[key] = maxLength;
        return undefined;
      },
      richtextText(key, _holder, value) {
        segments[key] = value;
      },
      mediaAlt(key, _item, value) {
        segments[key] = value;
      },
    });
    if (touched) fields.push(f.name);
  }
  if (includeSeo) {
    for (const key of SEO_TEXT_KEYS) {
      const v = seo?.[key];
      if (typeof v === "string" && v.trim() !== "") {
        segments[`s.${key}`] = v;
        limits[`s.${key}`] = SEO_LIMITS[key]!;
      }
    }
  }
  return { segments, limits, fields };
}

/**
 * Rebuild values with translated segments applied in place. Missing translations keep the
 * source text (reported by the caller as issues). Non-translatable fields are copied verbatim.
 */
export function applySegments(
  definition: ContentTypeDefinition,
  values: Record<string, unknown>,
  translated: TextSegments,
  resolveComponent: ResolveComponent = () => null,
  include?: IncludeSet,
): Record<string, unknown> {
  const out: Record<string, unknown> = structuredClone(values);
  walkFields(translatableFields(definition, include), out, "", "", resolveComponent, include, {
    text(key) {
      const t = translated[key];
      return typeof t === "string" ? t : undefined;
    },
    richtextText(key, holder) {
      const t = translated[key];
      if (typeof t === "string") holder.text = t;
    },
    mediaAlt(key, item) {
      const t = translated[key];
      if (typeof t === "string") item.alt = t;
    },
  });
  return out;
}

/**
 * Translated SEO record: text keys translated, ogImage/noindex carried over, canonical
 * dropped — a canonical override is an absolute URL specific to the source locale's page.
 */
export function applySeoSegments(
  seo: EntrySeo | null,
  translated: TextSegments,
): EntrySeo | null {
  if (!seo) return null;
  const out: EntrySeo = {};
  for (const key of SEO_TEXT_KEYS) {
    const source = seo[key];
    if (typeof source !== "string" || source.trim() === "") continue;
    const t = translated[`s.${key}`];
    out[key] = typeof t === "string" ? t : source;
  }
  if (seo.ogImage) out.ogImage = seo.ogImage;
  if (seo.noindex !== undefined) out.noindex = seo.noindex;
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Enforce hard schema limits on translated segments — translations expand (notably into
 * Spanish/German) and an overlong segment would fail entry validation wholesale. Trimming
 * is acceptable because the output is a reviewed draft; each trim is reported as an issue.
 */
export function clampSegments(
  translated: TextSegments,
  limits: SegmentLimits,
): { clamped: TextSegments; issues: string[] } {
  const clamped: TextSegments = { ...translated };
  const issues: string[] = [];
  for (const [key, max] of Object.entries(limits)) {
    const t = clamped[key];
    if (typeof t === "string" && t.length > max) {
      clamped[key] = t.slice(0, max).trimEnd();
      issues.push(`Trimmed to the ${max}-character limit: ${key}`);
    }
  }
  return { clamped, issues };
}

export function translationSystemPrompt(
  sourceLocale: string,
  targetLocale: string,
  limits: SegmentLimits,
): string {
  const limitLines = Object.entries(limits)
    .map(([k, n]) => `${k} ≤ ${n}`)
    .join(", ");
  return `You are a professional CMS content translator. Translate the values of the given JSON object from locale "${sourceLocale}" to locale "${targetLocale}".
Rules:
- Respond with a single JSON object with exactly the same keys; every value is the translation of the input value.
- Preserve inline placeholders, variables ({{like_this}}, %s), HTML tags/entities and URLs untouched.
- Keep brand names, SKUs and proper nouns as-is unless the target language has an established form.
- Match the register and length of the source — these are CMS field values, not prose to expand.${
    limitLines
      ? `\n- HARD length limits in characters — rephrase more concisely rather than exceed them: ${limitLines}`
      : ""
  }
- JSON only. No commentary, no code fences.`;
}
