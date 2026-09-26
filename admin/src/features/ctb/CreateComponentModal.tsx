/** New component modal — name → auto-generated API ID (same pattern as CreateTypeModal) */
import { useState } from "react";
import { IconX } from "@tabler/icons-react";
import { api, ApiError } from "../../api/client";
import { useInvalidatingMutation } from "../../hooks/queries";

export function CreateComponentModal({
  onClose,
  onCreated,
}: {
  onClose(): void;
  onCreated(uid: string): void;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const uid = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const valid = /^[a-z][a-z0-9_-]{1,63}$/.test(uid);

  const create = useInvalidatingMutation(
    () =>
      api<{ uid: string }>("/api/components", {
        method: "POST",
        body: { uid, name: name.trim(), definition: { fields: [] } },
      }),
    [["components"]],
  );

  return (
    <div className="fm-backdrop" onClick={onClose}>
      <div className="fm fm-narrow" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Create a component">
        <div className="fm-head">
          <div style={{ flex: 1 }}>
            <div className="fm-title">Create a component</div>
            <div className="fm-sub">A reusable field group — attach it to types or dynamic zones.</div>
          </div>
          <button className="fm-close" onClick={onClose} aria-label="Close"><IconX size="1.3rem" /></button>
        </div>

        <div className="fm-body-plain">
          <label className="field">
            <span>Display name</span>
            <input
              value={name} placeholder="SEO block" autoFocus
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <div className="field">
            <span>API ID</span>
            <div className="fm-readonly" style={{ justifyContent: "space-between" }}>
              <span>{uid || "…"}</span>
              <span style={{ fontSize: "1.05rem", color: "var(--text-3)", fontFamily: "var(--font-sans)" }}>
                generated
              </span>
            </div>
          </div>
          {error && <div className="form-error">{error}</div>}
        </div>

        <div className="fm-foot" style={{ padding: "1.6rem 2.4rem", justifyContent: "flex-end" }}>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button
            className="btn btn-primary" disabled={!valid || !name.trim() || create.isPending}
            onClick={() =>
              create.mutate(undefined, {
                onSuccess: (r) => onCreated(r.uid),
                onError: (e) => setError(e instanceof ApiError ? e.message : "Create failed"),
              })
            }
          >
            Continue to fields
          </button>
        </div>
      </div>
    </div>
  );
}
