/** Taxonomy (P9, UI for T2.5) — taxonomy list + folder tree of nodes (TaxonomyTree) + node editing in tabs (NodeDetail, 33-IMPL) */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { IconPlus, IconTrash } from "@tabler/icons-react";
import { api, ApiError } from "../../api/client";
import type { TaxonomyAttributeField, TaxonomyNode, TaxonomyRow } from "../../api/types";
import {
  useComponents,
  useInvalidatingMutation,
  useTaxonomies,
  useTaxonomyTree,
} from "../../hooks/queries";
import { SectionLayout } from "../../layout/SectionLayout";
import { Modal } from "../../components/common/Modal";
import { TaxonomyTree, type Draft } from "./TaxonomyTree";
import { NodeDetail, type NodePatch } from "./NodeDetail";

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
      {uid ? (
        <TaxonomyView
          key={uid} uid={uid} taxonomy={taxonomies?.find((t) => t.uid === uid)}
          // back to whatever is first in the refreshed list
          onDeleted={() => setSelectedUid(null)}
        />
      ) : (
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

function TaxonomyView({ uid, taxonomy, onDeleted }: { uid: string; taxonomy: TaxonomyRow | undefined; onDeleted(): void }) {
  const name = taxonomy?.name ?? uid;
  const { data: nodes } = useTaxonomyTree(uid);
  const { data: components } = useComponents();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(null);
  const [error, setError] = useState<string | null>(null);

  const invalidate = [["taxonomy-tree", uid]];
  const onError = (e: unknown) => setError(e instanceof ApiError ? e.message : "Request failed");
  const addNode = useInvalidatingMutation(
    (body: { parentId: string | null; name: string; slug: string }) =>
      api<TaxonomyNode>(`/api/taxonomies/${uid}/nodes`, { method: "POST", body }),
    invalidate,
  );
  const updateNode = useInvalidatingMutation(
    ({ id, patch }: { id: string; patch: NodePatch }) =>
      api(`/api/taxonomy-nodes/${id}`, { method: "PATCH", body: patch }),
    invalidate,
  );
  const deleteNode = useInvalidatingMutation(
    (nodeId: string) => api(`/api/taxonomy-nodes/${nodeId}`, { method: "DELETE" }),
    invalidate,
  );
  // Attribute field definitions live on the taxonomy; node values change with them (removed fields are pruned server-side)
  const updateTaxonomy = useInvalidatingMutation(
    (body: { attributeFields: TaxonomyAttributeField[] }) => api(`/api/taxonomies/${uid}`, { method: "PATCH", body }),
    [["taxonomies"], ...invalidate],
  );
  // Deleting the taxonomy itself — same grammar as "Delete this type" in the Content-Type Builder
  const [deleteOpen, setDeleteOpen] = useState(false);
  const qc = useQueryClient();
  const deleteTaxonomy = useInvalidatingMutation(
    () => api(`/api/taxonomies/${uid}`, { method: "DELETE" }),
    [["taxonomies"]],
  );
  const save = (id: string, patch: NodePatch) => {
    setError(null);
    updateNode.mutate({ id, patch }, { onError });
  };

  const list = nodes ?? [];
  const selected = list.find((n) => n.id === selectedId) ?? null;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{name}</h1>
          <span className="muted">
            <code>{uid}</code> · works like a folder tree — entries can sit in several nodes at once
          </span>
        </div>
        <button className="btn btn-primary" onClick={() => setDraft({ parentId: selected?.id ?? null })}>
          <IconPlus size="1.5rem" /> {selected ? `New node in “${selected.name}”` : "New node"}
        </button>
      </div>
      {error && <div className="form-error" style={{ marginBottom: "1.2rem" }}>{error}</div>}

      <div className="tax-layout">
        <TaxonomyTree
          nodes={list} selectedId={selectedId} onSelect={setSelectedId}
          draft={draft} setDraft={setDraft}
          onCreate={(parentId, nodeName, slug) => {
            setError(null);
            addNode.mutate({ parentId, name: nodeName, slug }, { onSuccess: (n) => setSelectedId(n.id), onError });
          }}
          onRename={(id, nodeName) => save(id, { name: nodeName })}
          onDelete={(n) => {
            const inside = list.filter((c) => c.path.startsWith(`${n.path}.`)).length;
            if (confirm(inside ? `Delete “${n.name}” and the ${inside} node(s) inside it?` : `Delete “${n.name}”?`)) {
              deleteNode.mutate(n.id, { onSuccess: () => setSelectedId(null), onError });
            }
          }}
        />
        <NodeDetail
          node={selected} taxonomyUid={uid} attributeFields={taxonomy?.attributeFields ?? []} components={components ?? []}
          onSave={save} onSaveFields={(attributeFields) => updateTaxonomy.mutateAsync({ attributeFields }).then(() => undefined)}
          saving={updateNode.isPending}
        />
      </div>

      <button className="btn-danger-outline" style={{ marginTop: "var(--space-5)" }} onClick={() => setDeleteOpen(true)}>
        Delete this taxonomy
      </button>

      {deleteOpen && (
        <div className="fm-backdrop" onClick={() => setDeleteOpen(false)}>
          <div className="fm-confirm" onClick={(e) => e.stopPropagation()} role="alertdialog" aria-label={`Delete ${name}`}>
            <div className="fm-confirm-head">
              <span className="fm-confirm-icon"><IconTrash size="1.5rem" /></span>
              <div className="fm-confirm-title">Delete {name}?</div>
            </div>
            <div className="fm-confirm-body">
              This removes the taxonomy and everything under it —{" "}
              <strong>{list.length} node{list.length === 1 ? "" : "s"}</strong> and every entry and asset
              classification that points at them. This cannot be undone.
            </div>
            <div className="fm-confirm-note">
              Entries and assets themselves stay — they only lose this classification. Delivery filters on <code>{uid}:…</code> start answering 404.
            </div>
            <div className="fm-confirm-foot">
              <button className="btn" onClick={() => setDeleteOpen(false)}>Cancel</button>
              <button
                className="btn-danger-solid" disabled={deleteTaxonomy.isPending}
                onClick={() =>
                  deleteTaxonomy.mutate(undefined, {
                    // drop the cached tree instead of refetching it — the taxonomy is gone (a refetch is a 404)
                    onSuccess: () => { qc.removeQueries({ queryKey: ["taxonomy-tree", uid] }); onDeleted(); },
                    onError: (e) => { setDeleteOpen(false); onError(e); },
                  })
                }
              >
                Delete taxonomy
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
