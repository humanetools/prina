/**
 * New workspace (48-IMPL) — instance administrators. A workspace is a separate set of content
 * (types, entries, assets, settings) inside this install; user accounts are shared.
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { api, apiErrorMessage, setWorkspaceSlug } from "../api/client";
import { Modal } from "../components/common/Modal";
import { useLocales } from "../hooks/queries";
import type { Workspace } from "../api/types";

/** "Brand Korea 2" → "brand-korea-2" (non-Latin names leave it empty for the person to type) */
function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

export function NewWorkspaceModal({ onClose }: { onClose(): void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data: locales } = useLocales();
  const current = locales?.find((l) => l.isDefault);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [localeCode, setLocaleCode] = useState<string | null>(null);
  const [localeName, setLocaleName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const code = localeCode ?? current?.code ?? "en";
  const label = localeName ?? current?.name ?? "English";

  const create = async () => {
    setBusy(true); setError(null);
    try {
      const ws = await api<Workspace>("/api/workspaces", {
        method: "POST",
        body: { name: name.trim(), slug: slug.trim(), defaultLocale: { code: code.trim(), name: label.trim() } },
      });
      // Open the new workspace right away — everything on screen belongs to the workspace in use
      // Refresh the list first — the header falls back to the first workspace when the selected one is not listed
      await qc.refetchQueries({ queryKey: ["workspaces"] });
      setWorkspaceSlug(ws.slug);
      // The page in view (a type, an entry) belongs to the old workspace — start from the Content Manager
      navigate("/content");
      await qc.invalidateQueries();
      onClose();
    } catch (e) {
      setError(apiErrorMessage(e, "Could not create the workspace"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="New workspace" onClose={onClose}>
      <p className="muted" style={{ marginTop: 0 }}>
        A workspace has its own content types, entries, assets and settings. User accounts are shared —
        give people a role in it from Settings › Users after switching to it.
      </p>
      <div className="form-fields">
        <label className="field">
          <span>Name</span>
          <input
            type="text" value={name} autoFocus placeholder="Brand Korea"
            onChange={(e) => { setName(e.target.value); if (!slugTouched) setSlug(slugify(e.target.value)); }}
          />
        </label>
        <label className="field">
          <span>Slug</span>
          <input
            type="text" value={slug} placeholder="brand-korea"
            onChange={(e) => { setSlugTouched(true); setSlug(e.target.value.toLowerCase()); }}
          />
          <small className="widget-hint">
            Used in API addresses (<code>?ws={slug || "brand-korea"}</code>) and cannot be changed later. 2–40 lowercase letters, digits and hyphens.
          </small>
        </label>
        <div className="row-gap" style={{ alignItems: "flex-end" }}>
          <label className="field" style={{ flex: "0 0 12rem" }}>
            <span>Default locale</span>
            <input type="text" value={code} onChange={(e) => setLocaleCode(e.target.value)} placeholder="en" />
          </label>
          <label className="field" style={{ flex: 1 }}>
            <span>Locale name</span>
            <input type="text" value={label} onChange={(e) => setLocaleName(e.target.value)} placeholder="English" />
          </label>
        </div>
      </div>
      {error && <div className="form-error" style={{ marginTop: "var(--space-3)" }}>{error}</div>}
      <div className="row-gap" style={{ marginTop: "var(--space-5)", justifyContent: "flex-end" }}>
        <button className="btn dialog-cancel" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn btn-primary" onClick={() => void create()} disabled={busy || !name.trim() || slug.trim().length < 2}>
          {busy ? "Creating…" : "Create workspace"}
        </button>
      </div>
    </Modal>
  );
}
