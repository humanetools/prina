/**
 * media widget (T4.4, §0.12) — Media Library picker + thumbnail chips (+ two-level alt when
 * enabled). Value items are "uuid" or {id, alt}: the object form appears only while a usage
 * override exists; clearing the override returns the item to a plain uuid.
 */
import { useState } from "react";
import { IconAlertTriangle, IconPhoto, IconX } from "@tabler/icons-react";
import { useAsset } from "../../../hooks/queries";
import { AssetPickerModal } from "../../media/AssetPickerModal";
import { assetThumbUrl } from "../../media/AssetGrid";
import type { WidgetProps } from "./BasicWidgets";

type MediaRefValue = string | { id: string; alt?: string | null };

interface Ref {
  id: string;
  /** string (incl. "" decorative) = usage override; undefined = inherit the asset alt */
  alt: string | undefined;
}

function toRef(item: MediaRefValue): Ref | null {
  if (typeof item === "string") return item ? { id: item, alt: undefined } : null;
  if (item && typeof item.id === "string") {
    return { id: item.id, alt: typeof item.alt === "string" ? item.alt : undefined };
  }
  return null;
}

function fromRef(ref: Ref): MediaRefValue {
  return ref.alt === undefined ? ref.id : { id: ref.id, alt: ref.alt };
}

function AssetChip({ id, onRemove }: { id: string; onRemove(): void }) {
  const { data: asset } = useAsset(id);
  const thumb = asset ? assetThumbUrl(asset) : null;
  return (
    <span className="asset-chip">
      {thumb ? <img src={thumb} alt="" /> : <IconPhoto size="1.6rem" />}
      <span className="asset-chip-name">{asset?.filename ?? id.slice(0, 8)}</span>
      <button type="button" onClick={onRemove} aria-label="Remove">
        <IconX size="1.2rem" />
      </button>
    </span>
  );
}

/** Two-level alt row: asset alt shows as the inherited placeholder, typing writes a usage override */
function AssetAltRow({ refItem, onOverride }: { refItem: Ref; onOverride(alt: string | undefined): void }) {
  const { data: asset } = useAsset(refItem.id);
  if (!asset) return null;
  const thumb = assetThumbUrl(asset);
  const hasOverride = refItem.alt !== undefined;
  const effective = hasOverride ? refItem.alt! : (asset.alt ?? null);
  const missing = effective === null;
  const decorative = effective === "";
  return (
    <div className="alt-row">
      <div className="alt-row-thumb">
        {thumb ? <img src={thumb} alt="" /> : <IconPhoto size="1.6rem" />}
      </div>
      <div className="alt-row-body">
        <div className="alt-row-name">
          {asset.filename}
          {missing && (
            <span className="alt-missing">
              <IconAlertTriangle size="1.1rem" /> no alt text
            </span>
          )}
          {decorative && <span className="muted"> · decorative</span>}
        </div>
        <input
          className="alt-editor-input"
          value={refItem.alt ?? ""}
          placeholder={
            asset.alt === null
              ? "Describe this image (override for this entry)…"
              : asset.alt === ""
                ? "(asset marked decorative — type to override here)"
                : asset.alt
          }
          onChange={(e) => onOverride(e.target.value)}
        />
        <div className="widget-hint" style={{ display: "flex", gap: "1rem", alignItems: "center" }}>
          {hasOverride ? (
            <>
              <span>override for this entry</span>
              <button type="button" className="link-btn" onClick={() => onOverride(undefined)}>
                use asset alt
              </button>
              {refItem.alt !== "" && (
                <button type="button" className="link-btn" onClick={() => onOverride("")}>
                  mark decorative here
                </button>
              )}
            </>
          ) : (
            <span>
              {asset.alt === null
                ? "asset has no alt — set one in Media Library, or type an override"
                : "inherited from the asset (shared by every usage)"}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

export function MediaWidget({ field, value, onChange }: WidgetProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const multiple = field.multiple === true;
  const items: MediaRefValue[] = multiple
    ? ((value as MediaRefValue[]) ?? [])
    : value
      ? [value as MediaRefValue]
      : [];
  const refs = items.map(toRef).filter((r): r is Ref => r !== null);

  const emit = (next: Ref[]) => {
    if (multiple) onChange(next.length ? next.map(fromRef) : null);
    else onChange(next.length ? fromRef(next[0]!) : null);
  };
  const remove = (id: string) => emit(refs.filter((r) => r.id !== id));
  const setOverride = (id: string, alt: string | undefined) =>
    emit(refs.map((r) => (r.id === id ? { ...r, alt } : r)));

  return (
    <div className="media-widget">
      <div className="chip-row">
        {refs.map((r) => (
          <AssetChip key={r.id} id={r.id} onRemove={() => remove(r.id)} />
        ))}
        {refs.length === 0 && <span className="muted">No asset selected</span>}
      </div>
      <button type="button" className="btn btn-sm" onClick={() => setPickerOpen(true)}>
        <IconPhoto size="1.4rem" /> {multiple ? "Add asset" : "Select asset"}
      </button>
      {field.multiple === true && field.min !== undefined && (
        <span className="widget-hint">At least {field.min as number} (completeness rule)</span>
      )}
      {/* a11y (§0.12): asset alt inherited, per-entry override stored in the field value */}
      {field.altText === true && refs.length > 0 && (
        <div className="alt-list">
          {refs.map((r) => (
            <AssetAltRow key={r.id} refItem={r} onOverride={(alt) => setOverride(r.id, alt)} />
          ))}
        </div>
      )}
      {pickerOpen && (
        <AssetPickerModal
          onClose={() => setPickerOpen(false)}
          onPick={(asset) => {
            if (refs.some((r) => r.id === asset.id)) return setPickerOpen(false);
            emit(multiple ? [...refs, { id: asset.id, alt: undefined }] : [{ id: asset.id, alt: undefined }]);
            setPickerOpen(false);
          }}
        />
      )}
    </div>
  );
}
