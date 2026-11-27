/** CTB SEO tab (§0.11) — per-type SEO panel config saved into content_types.options.seo */
import { useEffect, useMemo, useState } from "react";
import type { ContentType, SeoTypeOptions } from "../../../api/types";
import { Switch } from "../field-modal/ui";

const BUILTIN_TOKENS = new Set(["id", "documentId", "locale"]);

export function SeoTab({
  contentType,
  onSave,
}: {
  contentType: ContentType;
  onSave(patch: Record<string, unknown>): void;
}) {
  const saved: SeoTypeOptions = contentType.options?.seo ?? { enabled: false };
  const [seo, setSeo] = useState<SeoTypeOptions>(saved);
  useEffect(() => {
    setSeo(contentType.options?.seo ?? { enabled: false });
  }, [contentType.uid, contentType.options]);

  const fieldNames = useMemo(
    () => new Set(contentType.definition.fields.map((f) => f.name)),
    [contentType.definition.fields],
  );
  const unknownTokens = useMemo(() => {
    const source = `${seo.urlPattern ?? ""} ${seo.externalCanonicalPattern ?? ""}`;
    const tokens = [...source.matchAll(/\{([a-zA-Z0-9_-]+)\}/g)].map((m) => m[1]!);
    return [...new Set(tokens.filter((t) => !fieldNames.has(t) && !BUILTIN_TOKENS.has(t)))];
  }, [seo.urlPattern, seo.externalCanonicalPattern, fieldNames]);

  const dirty = JSON.stringify(seo) !== JSON.stringify(saved);
  const set = (patch: Partial<SeoTypeOptions>) => setSeo((s) => ({ ...s, ...patch }));

  return (
    <div className="form-fields narrow">
      <Switch
        on={seo.enabled}
        label="SEO panel"
        desc="Shows the SEO section on this type's entries and emits meta/OG head tags in delivery"
        onToggle={() => set({ enabled: !seo.enabled })}
      />

      {seo.enabled && (
        <>
          <label className="field">
            <span>URL pattern</span>
            <input
              value={seo.urlPattern ?? ""}
              placeholder="/articles/{slug}"
              onChange={(e) => set({ urlPattern: e.target.value || undefined })}
            />
          </label>
          {unknownTokens.length > 0 && (
            <p className="widget-hint" style={{ color: "var(--danger)" }}>
              Unknown token{unknownTokens.length > 1 ? "s" : ""}:{" "}
              {unknownTokens.map((t) => `{${t}}`).join(", ")} — use a field name or{" "}
              {"{id}"}, {"{locale}"}, {"{documentId}"}
            </p>
          )}
          <p className="widget-hint">
            Combined with the site base URL (Settings › System) into each entry's canonical URL.
          </p>

          <label className="field">
            <span>External canonical pattern (optional)</span>
            <input
              value={seo.externalCanonicalPattern ?? ""}
              placeholder="https://origin.example.com/posts/{slug}"
              onChange={(e) => set({ externalCanonicalPattern: e.target.value || undefined })}
            />
          </label>
          <p className="widget-hint">
            For syndicated/republished collections whose original lives on another site — it
            becomes the emitted canonical, and those entries are excluded from this site's
            sitemap (a sitemap must list canonical URLs only).
          </p>

          <Switch
            on={seo.strictPublish ?? false}
            label="Strict publish"
            desc="Block publishing while SEO checks report errors (default: warnings only)"
            onToggle={() => set({ strictPublish: !seo.strictPublish })}
          />

          <Switch
            on={seo.sitemap?.include ?? false}
            label="Include in sitemap"
            desc="Published entries of this type appear in /delivery/sitemap.xml"
            onToggle={() =>
              set({ sitemap: { ...seo.sitemap, include: !(seo.sitemap?.include ?? false) } })
            }
          />
          {/* priority/changefreq are deliberately not exposed: search engines ignore both,
              and <lastmod> (the one they do read) is emitted automatically from updatedAt.
              The options schema still accepts them for API users. (2026-08-21 decision) */}
        </>
      )}

      <div className="row-gap">
        <button
          className="btn btn-primary"
          disabled={!dirty || unknownTokens.length > 0}
          onClick={() => onSave({ options: { seo } })}
        >
          Save
        </button>
        {dirty && <span className="widget-hint">Unsaved changes</span>}
      </div>
    </div>
  );
}
