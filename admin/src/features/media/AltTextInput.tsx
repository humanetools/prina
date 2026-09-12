/**
 * Alt text editor (a11y, WCAG 1.1.1) — shared by the Media Library detail panel and the
 * media widget in Content Manager. Alt lives on the asset, so an edit here applies to every
 * usage of that image, including richtext embeds.
 */
import { useEffect, useRef, useState } from "react";
import { api } from "../../api/client";
import { useInvalidatingMutation } from "../../hooks/queries";
import type { Asset } from "../../api/types";

export function AltTextInput({
  asset,
  compact = false,
}: {
  asset: Pick<Asset, "id" | "alt">;
  compact?: boolean;
}) {
  const [draft, setDraft] = useState(asset.alt ?? "");
  const [decorative, setDecorative] = useState(asset.alt === "");
  const [saved, setSaved] = useState(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Re-sync when the panel switches to another asset
  useEffect(() => {
    setDraft(asset.alt ?? "");
    setDecorative(asset.alt === "");
    setSaved(false);
  }, [asset.id, asset.alt]);

  const save = useInvalidatingMutation(
    (alt: string | null) =>
      api(`/api/assets/${asset.id}`, { method: "PATCH", body: JSON.stringify({ alt }) }),
    [["assets"], ["asset", asset.id]],
  );

  const commit = (alt: string | null) => {
    if (alt === (asset.alt ?? null)) return;
    save.mutate(alt, {
      onSuccess: () => {
        setSaved(true);
        if (savedTimer.current) clearTimeout(savedTimer.current);
        savedTimer.current = setTimeout(() => setSaved(false), 1600);
      },
    });
  };
  useEffect(() => {
    return () => {
      if (savedTimer.current) clearTimeout(savedTimer.current);
    };
  }, []);

  return (
    <div className={compact ? "alt-editor compact" : "alt-editor"}>
      <label className="field">
        <span>
          Alt text
          {saved && <span className="alt-saved"> · saved</span>}
        </span>
        <input
          value={draft}
          disabled={decorative}
          placeholder={decorative ? "Decorative — no description needed" : "Describe the image for screen readers"}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => !decorative && commit(draft)}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
        />
      </label>
      <label className="alt-decorative">
        <input
          type="checkbox"
          checked={decorative}
          onChange={(e) => {
            const on = e.target.checked;
            setDecorative(on);
            if (on) {
              setDraft("");
              commit("");
            } else {
              commit(null);
            }
          }}
        />
        <span>Decorative image (skipped by screen readers)</span>
      </label>
    </div>
  );
}
