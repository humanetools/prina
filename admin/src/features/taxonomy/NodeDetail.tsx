/** Right-hand panel of the taxonomy page — edit the selected node: name, slug and attribute set */
import { useEffect, useState } from "react";
import type { ComponentDef, TaxonomyNode } from "../../api/types";

export interface NodePatch { name?: string; slug?: string; attributeComponentUid?: string | null }
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function NodeDetail({
  node, taxonomyUid, components, onSave, saving,
}: {
  node: TaxonomyNode | null;
  taxonomyUid: string;
  components: ComponentDef[];
  onSave(id: string, patch: NodePatch): void;
  saving: boolean;
}) {
  const [name, setName] = useState(node?.name ?? "");
  const [slug, setSlug] = useState(node?.slug ?? "");
  useEffect(() => setName(node?.name ?? ""), [node?.id, node?.name]);
  useEffect(() => setSlug(node?.slug ?? ""), [node?.id, node?.slug]);

  if (!node) {
    return (
      <section className="tax-detail">
        <div className="panel-title">Node</div>
        <p className="widget-hint" style={{ marginTop: "1.6rem" }}>
          Select a node to rename it or give it an attribute set. Double-click a name (or press F2) to rename in place.
        </p>
      </section>
    );
  }

  const attr = node.attributeComponentUid ? components.find((c) => c.uid === node.attributeComponentUid) : undefined;
  const commitName = () => {
    const next = name.trim();
    if (next && next !== node.name) onSave(node.id, { name: next });
    else setName(node.name);
  };

  const slugOk = SLUG_RE.test(slug);
  const commitSlug = () => {
    if (slugOk && slug !== node.slug) onSave(node.id, { slug });
    else if (!slugOk) setSlug(node.slug);
  };

  return (
    <section className="tax-detail">
      <div className="panel-title">Node</div>
      <div className="form-fields" style={{ marginTop: "1.6rem" }}>
        <label className="field"><span>Name</span>
          <input
            value={name} disabled={saving}
            onChange={(e) => setName(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
          />
        </label>
        <label className="field"><span>Slug</span>
          <input
            value={slug} disabled={saving} spellCheck={false} className="tax-slug-input"
            onChange={(e) => setSlug(e.target.value.toLowerCase())}
            onBlur={commitSlug}
            onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
          />
          <p className={slugOk ? "widget-hint" : "widget-hint danger"}>
            {slugOk
              ? "This node's own segment of the path. Filled in from the name — change it for a readable one."
              : "Lowercase letters, digits, - and _ (must start with a letter or digit)."}
          </p>
        </label>
        <div className="field"><span>Path</span>
          <code className="tax-path-box">{node.path}</code>
          <p className="widget-hint">
            Parent slugs + this slug, joined by dots — changes when a slug on the way changes. Sites filter with{" "}
            <code className="tax-path">?taxonomy={taxonomyUid}:{node.path}</code>
          </p>
        </div>
        <label className="field"><span>Attribute set (optional)</span>
          <select
            value={node.attributeComponentUid ?? ""} disabled={saving}
            onChange={(e) => onSave(node.id, { attributeComponentUid: e.target.value || null })}
          >
            <option value="">None</option>
            {components.map((c) => <option key={c.uid} value={c.uid}>{c.name} ({c.uid})</option>)}
          </select>
          <p className="widget-hint">
            A component whose fields appear on entries classified here — e.g. wattage and port only on chargers.
          </p>
        </label>
        {attr && (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.7rem" }}>
            {attr.definition.fields.map((f) => (
              <div key={f.name} className="tax-attr-row"><span>{f.label ?? f.name}</span><code>{f.type}</code></div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
