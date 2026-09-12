/** New content type modal (design NEW CONTENT TYPE) — kind selection + name → auto-generated API ID */
import { useState } from "react";
import { IconX } from "@tabler/icons-react";
import { api, ApiError } from "../../api/client";
import { ContentTypeKind } from "../../api/types";
import { useInvalidatingMutation } from "../../hooks/queries";

const KINDS = [
  {
    kind: ContentTypeKind.Collection,
    label: "Collection Type",
    desc: "Many entries — products, articles",
  },
  {
    kind: ContentTypeKind.Single,
    label: "Single Type",
    desc: "One entry — homepage, global SEO",
  },
];

export function CreateTypeModal({
  onClose,
  onCreated,
}: {
  onClose(): void;
  onCreated(uid: string): void;
}) {
  const [kind, setKind] = useState<ContentTypeKind>(ContentTypeKind.Collection);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const uid = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const valid = /^[a-z][a-z0-9_-]{1,63}$/.test(uid);

  const create = useInvalidatingMutation(
    () =>
      api<{ uid: string }>("/api/content-types", {
        method: "POST",
        body: { uid, name: name.trim(), kind, definition: { fields: [] } },
      }),
    [["content-types"]],
  );

  return (
    <div className="fm-backdrop" onClick={onClose}>
      <div className="fm fm-narrow" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Create a new type">
        <div className="fm-head">
          <div style={{ flex: 1 }}>
            <div className="fm-title">Create a new type</div>
            <div className="fm-sub">Fields, predicates and a starter template come next.</div>
          </div>
          <button className="fm-close" onClick={onClose} aria-label="Close"><IconX size="1.3rem" /></button>
        </div>

        <div className="fm-body-plain">
          <div className="kind-row">
            {KINDS.map((k) => (
              <button
                key={k.kind}
                className={kind === k.kind ? "opt-card on" : "opt-card"}
                style={{ flex: 1 }}
                onClick={() => setKind(k.kind)}
              >
                <span className="opt-radio" style={{ marginTop: "0.2rem" }} />
                <span className="opt-card-text">
                  <span className="opt-card-name">{k.label}</span>
                  <span className="opt-card-desc">{k.desc}</span>
                </span>
              </button>
            ))}
          </div>

          <label className="field">
            <span>Display name</span>
            <input
              value={name} placeholder="Bundle" autoFocus
              onChange={(e) => setName(e.target.value)}
            />
          </label>

          <div className="field">
            <span>API ID</span>
            <div className="fm-readonly" style={{ justifyContent: "space-between" }}>
              <span>api::{uid || "…"}</span>
              <span style={{ fontSize: "1.05rem", color: "var(--text-3)", fontFamily: "var(--font-sans)" }}>
                generated
              </span>
            </div>
          </div>

          <div className="fm-static-toggle">
            <span className="mini-switch" aria-hidden />
            <span style={{ flex: 1, fontSize: "1.25rem", color: "var(--text-2)" }}>
              Draft &amp; Publish enabled
            </span>
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
