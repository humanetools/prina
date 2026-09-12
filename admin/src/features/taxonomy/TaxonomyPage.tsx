/** Taxonomy (P9, UI for T2.5) — hierarchy tree + node CRUD + attribute set linking */
import { useState } from "react";
import { IconPlus, IconTrash } from "@tabler/icons-react";
import { api, ApiError } from "../../api/client";
import type { TaxonomyNode } from "../../api/types";
import {
  useComponents,
  useInvalidatingMutation,
  useTaxonomies,
  useTaxonomyTree,
} from "../../hooks/queries";
import { SectionLayout } from "../../layout/SectionLayout";
import { Modal } from "../../components/common/Modal";

export function TaxonomyPage() {
  const { data: taxonomies } = useTaxonomies();
  const [selectedUid, setSelectedUid] = useState<string | null>(null);
  const [createTaxOpen, setCreateTaxOpen] = useState(false);
  const uid = selectedUid ?? taxonomies?.[0]?.uid;

  const panel = (
    <>
      <div className="nav-group">
        {(taxonomies ?? []).map((t) => (
          <button key={t.uid}
            className={t.uid === uid ? "nav-item active" : "nav-item"}
            onClick={() => setSelectedUid(t.uid)}>
            {t.name}
          </button>
        ))}
      </div>
      <button className="btn btn-sm btn-block" onClick={() => setCreateTaxOpen(true)}>
        <IconPlus size="1.4rem" /> New taxonomy
      </button>
    </>
  );

  return (
    <SectionLayout panelTitle="Taxonomy" panel={panel}>
      {uid ? <TaxonomyTree uid={uid} /> : (
        <div className="empty-state"><p>Create a taxonomy to start classifying.</p></div>
      )}
      {createTaxOpen && (
        <CreateTaxonomyModal onClose={() => setCreateTaxOpen(false)} onCreated={setSelectedUid} />
      )}
    </SectionLayout>
  );
}

function CreateTaxonomyModal({
  onClose,
  onCreated,
}: {
  onClose(): void;
  onCreated(uid: string): void;
}) {
  const [form, setForm] = useState({ uid: "", name: "" });
  const [error, setError] = useState<string | null>(null);
  const create = useInvalidatingMutation(
    () => api("/api/taxonomies", { method: "POST", body: form }),
    [["taxonomies"]],
  );
  return (
    <Modal title="New taxonomy" onClose={onClose}>
      <div className="form-fields">
        <label className="field"><span>Name</span>
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
        <label className="field"><span>uid</span>
          <input value={form.uid} onChange={(e) => setForm({ ...form, uid: e.target.value })}
            placeholder="e.g. catalog" /></label>
        {error && <div className="form-error">{error}</div>}
        <button className="btn btn-primary btn-block" disabled={!form.uid || !form.name}
          onClick={() =>
            create.mutate(undefined, {
              onSuccess: () => { onCreated(form.uid); onClose(); },
              onError: (e) => setError(e instanceof ApiError ? e.message : "failed"),
            })
          }>
          Create
        </button>
      </div>
    </Modal>
  );
}

function TaxonomyTree({ uid }: { uid: string }) {
  const { data: nodes } = useTaxonomyTree(uid);
  const { data: components } = useComponents();
  const [addUnder, setAddUnder] = useState<TaxonomyNode | null | "root">(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", slug: "", attributeComponentUid: "" });
  const [error, setError] = useState<string | null>(null);

  const invalidate = [["taxonomy-tree", uid]];
  const addNode = useInvalidatingMutation(
    (parentId: string | null) =>
      api(`/api/taxonomies/${uid}/nodes`, {
        method: "POST",
        body: {
          parentId,
          name: form.name,
          slug: form.slug,
          attributeComponentUid: form.attributeComponentUid || null,
        },
      }),
    invalidate,
  );
  const deleteNode = useInvalidatingMutation(
    (nodeId: string) => api(`/api/taxonomy-nodes/${nodeId}`, { method: "DELETE" }),
    invalidate,
  );

  const selected = (nodes ?? []).find((n) => n.id === selectedId) ?? null;
  const attrComponent = selected?.attributeComponentUid
    ? components?.find((c) => c.uid === selected.attributeComponentUid)
    : undefined;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{uid}</h1>
          <span className="muted">
            Click a node to inspect its attribute set · entries may sit in several nodes at once
          </span>
        </div>
        <button className="btn btn-primary" onClick={() => setAddUnder("root")}>
          <IconPlus size="1.5rem" /> Root node
        </button>
      </div>

      <div className="tax-layout">
        <div className="tax-tree-card">
          {(nodes ?? []).map((n) => {
            const depth = n.path.split(".").length - 1;
            return (
              <div
                key={n.id}
                className={n.id === selectedId ? "tax-node selected" : "tax-node"}
                style={{ paddingLeft: "1.6rem" + depth * 22 }}
                onClick={() => setSelectedId(n.id === selectedId ? null : n.id)}
              >
                <span className="tax-node-grip" title="Drag to reorder or nest">
                  <svg width="1.2rem" height="1.2rem" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6">
                    <path d="M2.6 4h6.8M2.6 8h6.8" />
                  </svg>
                </span>
                <span className="tax-node-label">{n.name}</span>
                <code className="tax-node-path">{n.path}</code>
                {n.attributeComponentUid && (
                  <span className="chip chip-sm" title="Entries here show this attribute group automatically">
                    Attribute set
                  </span>
                )}
                <span className="tax-node-actions" onClick={(e) => e.stopPropagation()}>
                  <button className="btn btn-ghost btn-icon" title="Add child node"
                    onClick={() => setAddUnder(n)}>
                    <IconPlus size="1.3rem" />
                  </button>
                  <button className="btn btn-ghost btn-icon" title="Delete subtree"
                    onClick={() => {
                      if (confirm(`Delete '${n.name}' and all its child nodes?`)) {
                        deleteNode.mutate(n.id, {
                          onSuccess: () => setSelectedId(null),
                        });
                      }
                    }}>
                    <IconTrash size="1.3rem" />
                  </button>
                </span>
              </div>
            );
          })}
          {(nodes ?? []).length === 0 && (
            <div className="empty-state"><p>No nodes.</p></div>
          )}
        </div>

        <section className="tax-detail">
          <div className="panel-title">Node · {selected?.name ?? "none selected"}</div>
          {selected ? (
            <>
              {selected.attributeComponentUid ? (
                <div className="tax-attach-note">
                  <strong>Attribute set attached</strong>
                  <p>
                    Entries classified under this node automatically show the{" "}
                    <strong style={{ fontWeight: 600 }}>
                      {attrComponent?.name ?? selected.attributeComponentUid}
                    </strong>{" "}
                    attribute group in their edit form.
                  </p>
                </div>
              ) : (
                <p className="widget-hint" style={{ marginTop: "1.6rem" }}>
                  No attribute set attached. Assign a component when creating the node and
                  entries under it will show the attribute group.
                </p>
              )}
              {attrComponent && (
                <div style={{ marginTop: "1.6rem", display: "flex", flexDirection: "column", gap: "0.7rem" }}>
                  {attrComponent.definition.fields.map((f) => (
                    <div key={f.name} className="tax-attr-row">
                      <span>{f.label ?? f.name}</span>
                      <code>{f.type}</code>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <p className="widget-hint" style={{ marginTop: "1.6rem" }}>
              Select a node on the left.
            </p>
          )}
        </section>
      </div>

      {addUnder !== null && (
        <Modal
          title={addUnder === "root" ? "Add root node" : `'${addUnder.name}' Add child node`}
          onClose={() => setAddUnder(null)}
        >
          <div className="form-fields">
            <label className="field"><span>Name</span>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
            <label className="field"><span>Slug (lowercase, digits, -)</span>
              <input value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} /></label>
            <label className="field">
              <span>Attribute set component (optional)</span>
              <select value={form.attributeComponentUid}
                onChange={(e) => setForm({ ...form, attributeComponentUid: e.target.value })}>
                <option value="">None</option>
                {(components ?? []).map((c) => (
                  <option key={c.uid} value={c.uid}>{c.name} ({c.uid})</option>
                ))}
              </select>
              <span className="widget-hint">When attached, entries under this node show the attribute group in their edit form.</span>
            </label>
            {error && <div className="form-error">{error}</div>}
            <button className="btn btn-primary btn-block" disabled={!form.name || !form.slug}
              onClick={() =>
                addNode.mutate(addUnder === "root" ? null : addUnder.id, {
                  onSuccess: () => {
                    setAddUnder(null);
                    setForm({ name: "", slug: "", attributeComponentUid: "" });
                  },
                  onError: (e) => setError(e instanceof ApiError ? e.message : "failed"),
                })
              }>
              Add
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
