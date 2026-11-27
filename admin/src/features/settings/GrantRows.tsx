/**
 * Cloudflare-style permission rows (20-IMPL custom mode): [Area ▾] [Item ▾] [Read|Edit ▾] (+ types) · "+ Add more".
 * The area select narrows the item select; edit-only items pin the level; typed items expose a type picker.
 */
import { IconX } from "@tabler/icons-react";
import { ApiGrantArea, ApiGrantItem, ApiGrantLevel, type ApiGrant, type ContentType } from "../../api/types";

export const AREA_LABEL: Record<ApiGrantArea, string> = {
  [ApiGrantArea.Ctb]: "Content-type Builder",
  [ApiGrantArea.Content]: "Content",
  [ApiGrantArea.Media]: "Media",
  [ApiGrantArea.Templates]: "Templates",
  [ApiGrantArea.Locales]: "Locales",
  [ApiGrantArea.Taxonomies]: "Taxonomies",
};
export const ITEM_META: Record<ApiGrantItem, { area: ApiGrantArea; label: string; hint: string; editOnly?: boolean; typed?: boolean }> = {
  [ApiGrantItem.ContentTypes]: { area: ApiGrantArea.Ctb, label: "Content types", hint: "types, fields, predicate & SEO options, presets, schema.org lookups" },
  [ApiGrantItem.Components]: { area: ApiGrantArea.Ctb, label: "Components", hint: "/api/components" },
  [ApiGrantItem.Entries]: { area: ApiGrantArea.Content, label: "Entries", hint: "read / create / update / delete entries, draft preview links", typed: true },
  [ApiGrantItem.Publish]: { area: ApiGrantArea.Content, label: "Publish", hint: "workflow transitions incl. publish", editOnly: true, typed: true },
  [ApiGrantItem.Import]: { area: ApiGrantArea.Content, label: "Import", hint: "CSV import (parse, validate, execute)", editOnly: true, typed: true },
  [ApiGrantItem.Assets]: { area: ApiGrantArea.Media, label: "Assets", hint: "uploads, alt text, delete" },
  [ApiGrantItem.Templates]: { area: ApiGrantArea.Templates, label: "Templates", hint: "save, activate versions, preview (edit includes script.js)" },
  [ApiGrantItem.Locales]: { area: ApiGrantArea.Locales, label: "Locales", hint: "/api/locales" },
  [ApiGrantItem.Taxonomies]: { area: ApiGrantArea.Taxonomies, label: "Taxonomies", hint: "taxonomies and nodes" },
};
const ALL_TYPES = "__all__";

/** One editable row — `item` may be empty while the user is still choosing */
export interface GrantRow { area: ApiGrantArea; item: ApiGrantItem | ""; level: ApiGrantLevel; /** "Specific types…" chosen — list stays open even while empty */ specific: boolean; types: string[] }
export const emptyRow = (): GrantRow => ({ area: ApiGrantArea.Content, item: "", level: ApiGrantLevel.Read, specific: false, types: [] });
/** A row counts once it names an item; a "specific types" row also needs at least one type ticked */
export const rowComplete = (r: GrantRow) => !!r.item && (!r.specific || r.types.length > 0);
export const rowsToGrants = (rows: GrantRow[]): ApiGrant[] =>
  rows.filter(rowComplete).map((r) => ({ item: r.item as ApiGrantItem, level: r.level, ...(ITEM_META[r.item as ApiGrantItem].typed && r.specific ? { types: r.types } : {}) }));

export function GrantRows({ rows, onChange, contentTypes }: { rows: GrantRow[]; onChange(rows: GrantRow[]): void; contentTypes: ContentType[] | undefined }) {
  const update = (i: number, patch: Partial<GrantRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const remove = (i: number) => onChange(rows.filter((_, j) => j !== i));
  return (
    <div className="grant-rows">
      {rows.map((row, i) => {
        const meta = row.item ? ITEM_META[row.item] : null;
        const items = (Object.keys(ITEM_META) as ApiGrantItem[]).filter((it) => ITEM_META[it].area === row.area);
        return (
          <div key={i} className="grant-row">
            <select className="grant-sel area" value={row.area} aria-label="Area"
              onChange={(e) => update(i, { area: e.target.value as ApiGrantArea, item: "", level: ApiGrantLevel.Read, specific: false, types: [] })}>
              {(Object.keys(AREA_LABEL) as ApiGrantArea[]).map((a) => <option key={a} value={a}>{AREA_LABEL[a]}</option>)}
            </select>
            <select className="grant-sel item" value={row.item} aria-label="Item"
              onChange={(e) => { const it = e.target.value as ApiGrantItem | ""; update(i, { item: it, level: it && ITEM_META[it].editOnly ? ApiGrantLevel.Edit : row.level, specific: false, types: [] }); }}>
              <option value="">Select</option>
              {items.map((it) => <option key={it} value={it}>{ITEM_META[it].label}</option>)}
            </select>
            <select className="grant-sel level" value={row.level} aria-label="Level" disabled={!row.item || !!meta?.editOnly}
              onChange={(e) => update(i, { level: e.target.value as ApiGrantLevel })}>
              <option value={ApiGrantLevel.Read}>Read</option>
              <option value={ApiGrantLevel.Edit}>Edit</option>
            </select>
            {meta?.typed && (
              <select className="grant-sel types" value={row.specific ? "__some__" : ALL_TYPES} aria-label="Content types"
                onChange={(e) => update(i, { specific: e.target.value !== ALL_TYPES, types: e.target.value === ALL_TYPES ? [] : row.types })}>
                <option value={ALL_TYPES}>All content types</option>
                <option value="__some__">Specific types…</option>
              </select>
            )}
            <button type="button" className="grant-remove" title="Remove" onClick={() => remove(i)} disabled={rows.length === 1}><IconX size="1.3rem" /></button>
            {meta && <div className="grant-hint">{meta.hint}{meta.editOnly ? " · edit only" : ""}</div>}
            {meta?.typed && row.specific && (
              <div className="grant-types">
                {row.types.length === 0 && <span className="widget-hint" style={{ width: "100%" }}>Tick at least one type.</span>}
                {(contentTypes ?? []).map((t) => (
                  <label key={t.uid} className="check">
                    <input type="checkbox" checked={row.types.includes(t.uid)}
                      onChange={(e) => update(i, { types: e.target.checked ? [...row.types, t.uid] : row.types.filter((u) => u !== t.uid) })} />
                    {t.name} <code>{t.uid}</code>
                  </label>
                ))}
              </div>
            )}
          </div>
        );
      })}
      <button type="button" className="link-btn grant-add" onClick={() => onChange([...rows, emptyRow()])}>+ Add more</button>
    </div>
  );
}

/** "Content · Entries · edit · product, article" chips for token cards */
export function GrantChips({ grants }: { grants: ApiGrant[] }) {
  return (
    <span className="scope-chips">
      {grants.map((g, i) => (
        <span key={i} className={`scope-chip ${g.level}`} title={ITEM_META[g.item].hint}>
          {ITEM_META[g.item].label.toLowerCase()} · {g.level}{g.types?.length ? ` · ${g.types.join(", ")}` : ""}
        </span>
      ))}
    </span>
  );
}

export function describeGrants(grants: ApiGrant[]): string {
  return grants.map((g) => `${g.level} ${ITEM_META[g.item].label.toLowerCase()}${g.types?.length ? ` (${g.types.join(", ")})` : ""}`).join(" · ");
}
