/** Entry SEO panel (§0.11) — shown when the type's SEO option is on; saves via its own PUT (taxonomy pattern) */
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { IconSearch, IconX } from "@tabler/icons-react";
import { api } from "../../api/client";
import type {
  ContentType,
  EntryDetail,
  EntrySeo,
  WorkspaceSeoSettings,
} from "../../api/types";
import { useAsset, useInvalidatingMutation } from "../../hooks/queries";
import { AssetPickerModal } from "../media/AssetPickerModal";
import { assetThumbUrl } from "../media/AssetGrid";

const TITLE_MAX = 60;
const DESC_MAX = 160;

/** Client mirror of the server's URL resolution — preview only, the server stays authoritative */
function previewUrl(
  seo: EntrySeo,
  contentType: ContentType,
  detail: EntryDetail,
  ws: WorkspaceSeoSettings | undefined,
): string | null {
  if (seo.canonical) return seo.canonical;
  const pattern = contentType.options?.seo?.urlPattern;
  if (!ws?.siteBaseUrl || !pattern) return null;
  let failed = false;
  const path = pattern.replace(/\{([a-zA-Z0-9_-]+)\}/g, (_m, token: string) => {
    const raw =
      token === "id" ? detail.entry.id
      : token === "documentId" ? detail.entry.documentId
      : token === "locale" ? detail.entry.locale
      : detail.effectiveValues[token];
    if (raw === null || raw === undefined || raw === "") { failed = true; return ""; }
    if (typeof raw !== "string" && typeof raw !== "number") { failed = true; return ""; }
    return encodeURIComponent(String(raw));
  });
  return failed ? null : ws.siteBaseUrl.replace(/\/+$/, "") + path;
}

function Counter({ value, max }: { value: string; max: number }) {
  const over = value.length > max;
  return (
    <span className="widget-hint" style={over ? { color: "var(--danger)" } : undefined}>
      {value.length}/{max}
    </span>
  );
}

export function SeoSection({
  typeUid,
  detail,
  contentType,
}: {
  typeUid: string;
  detail: EntryDetail;
  contentType: ContentType;
}) {
  const savedSeo = useMemo<EntrySeo>(() => detail.entry.seo ?? {}, [detail.entry.seo]);
  const [seo, setSeo] = useState<EntrySeo>(savedSeo);
  const [pickerOpen, setPickerOpen] = useState(false);
  useEffect(() => setSeo(savedSeo), [savedSeo, detail.entry.id]);

  const { data: ws } = useQuery({
    queryKey: ["workspace-settings"],
    queryFn: () => api<{ settings: { seo?: WorkspaceSeoSettings } }>("/api/workspace-settings"),
  });
  const { data: ogAsset } = useAsset(seo.ogImage);

  const save = useInvalidatingMutation(
    (record: EntrySeo) =>
      api(`/api/content/${typeUid}/${detail.entry.id}/seo`, {
        method: "PUT",
        // Strip empty strings — the record is full-replace, absent key = unset
        body: {
          seo: Object.fromEntries(
            Object.entries(record).filter(([, v]) => v !== "" && v !== undefined && v !== false),
          ),
        },
      }),
    [["entry", typeUid, detail.entry.id]],
  );

  const dirty = JSON.stringify(seo) !== JSON.stringify(savedSeo);
  const set = (patch: Partial<EntrySeo>) => setSeo((s) => ({ ...s, ...patch }));
  const url = previewUrl(seo, contentType, detail, ws?.settings.seo);

  return (
    <section className="taxonomy-section">
      <div className="section-head">
        <h3><IconSearch size="1.6rem" /> SEO</h3>
        <button
          className="btn btn-sm"
          disabled={!dirty || save.isPending}
          onClick={() => save.mutate(seo)}
        >
          {save.isPending ? "Saving…" : "Save SEO"}
        </button>
      </div>

      <div className="form-fields narrow">
        <label className="field">
          <span>Meta title <Counter value={seo.metaTitle ?? ""} max={TITLE_MAX} /></span>
          <input
            value={seo.metaTitle ?? ""}
            placeholder={
              (detail.effectiveValues[contentType.definition.displayField ?? ""] as string) ||
              "Search result title"
            }
            onChange={(e) => set({ metaTitle: e.target.value })}
          />
        </label>
        <label className="field">
          <span>Meta description <Counter value={seo.metaDescription ?? ""} max={DESC_MAX} /></span>
          <textarea
            rows={2}
            value={seo.metaDescription ?? ""}
            placeholder="Search snippet — aim for 50–160 characters"
            onChange={(e) => set({ metaDescription: e.target.value })}
          />
        </label>
        {/* Canonical is fully derived (base URL + type pattern) — no manual input by design
            (2026-08-21 decision: duplicate handling is the frontend's concern; the API-level
            seo.canonical field stays supported for power users/agents and wins when set). */}
        <p className="widget-hint">
          {url ? (
            <>Canonical URL (derived): <code>{url}</code></>
          ) : (
            "No canonical URL — set the site base URL (Settings › System) and this type's URL pattern (CTB › SEO)"
          )}
        </p>

        <div className="field">
          <span>OG image</span>
          <div className="row-gap">
            {ogAsset && seo.ogImage && (
              <span className="chip">
                {assetThumbUrl(ogAsset) && (
                  <img
                    src={assetThumbUrl(ogAsset)!}
                    alt=""
                    style={{ width: "2.4rem", height: "2.4rem", objectFit: "cover", borderRadius: "0.4rem" }}
                  />
                )}
                {ogAsset.filename}
                <button onClick={() => set({ ogImage: undefined })} aria-label="Remove OG image">
                  <IconX size="1.2rem" />
                </button>
              </span>
            )}
            <button className="btn btn-sm" onClick={() => setPickerOpen(true)}>
              {seo.ogImage ? "Change" : "Select image"}
            </button>
          </div>
        </div>

        <label className="field-inline">
          <input
            type="checkbox"
            checked={seo.noindex ?? false}
            onChange={(e) => set({ noindex: e.target.checked || undefined })}
          />
          <span>noindex — ask search engines not to index this entry</span>
        </label>
      </div>

      {pickerOpen && (
        <AssetPickerModal
          onPick={(asset) => {
            set({ ogImage: asset.id });
            setPickerOpen(false);
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </section>
  );
}
