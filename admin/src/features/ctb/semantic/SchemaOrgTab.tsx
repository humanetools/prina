/**
 * Predicate·schema.org tab (design Relationship graph) —
 * left: relation graph canvas (pan, node drag, edge select) / splitter / right: per-selection inspector.
 * subject selection = the type's identity (schema.org); edge selection = the relation's meaning (predicate + inverse).
 */
import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { IconX } from "@tabler/icons-react";
import { api } from "../../../api/client";
import { FieldType, type ComponentDef, type ContentType, type Entry, type FieldDef, type SemanticMapping } from "../../../api/types";
import { FieldTypeTile } from "../../../components/common/FieldTypeTile";
import { TYPE_LABEL } from "../field-modal/meta";
import { useComponents, useContentTypes, useInvalidatingMutation } from "../../../hooks/queries";
import { collectRelationPaths } from "./relation-paths";
import { SchemaCombobox } from "./SchemaCombobox";
import { PredicateInput } from "./PredicateInput";
import { KgTypesCanvas, type KgSelection } from "./KgTypesCanvas";
import { buildFieldMap, candidateProps } from "./schema-org";

const STATUS_DOT: Record<string, string> = {
  name: "var(--published)",
  valid: "var(--published)",
  external: "var(--accent)",
  custom: "var(--accent)",
  dropped: "var(--danger)",
  excluded: "var(--text-3)",
};

export function SchemaOrgTab({
  contentType,
  onSave,
}: {
  contentType: ContentType;
  onSave(patch: Record<string, unknown>): void;
}) {
  const { data: types } = useContentTypes();
  const { data: components } = useComponents();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [selection, setSelection] = useState<KgSelection>({ kind: "self" });
  const [showAll, setShowAll] = useState(
    () => searchParams.get("graph") === "all" || localStorage.getItem("kg-showall") === "1",
  );
  const toggleShowAll = () =>
    setShowAll((v) => {
      try { localStorage.setItem("kg-showall", v ? "0" : "1"); } catch { /* ignore */ }
      return !v;
    });
  const [resetToken, setResetToken] = useState(0);
  // Predicates of relations inside a component are saved on the component, not the type
  const updateComponent = useInvalidatingMutation(
    ({ uid, patch }: { uid: string; patch: Record<string, unknown> }) =>
      api(`/api/components/${uid}`, { method: "PUT", body: patch }),
    [["components"], ["content-types"]],
  );
  const [paneRatio, setPaneRatio] = useState(0.56);
  const [fmOpen, setFmOpen] = useState(false);
  // Avoid stale edge selection from the previous type when navigating between types (Show all types nav)
  useEffect(() => {
    setSelection({ kind: "self" });
  }, [contentType.uid]);
  const [snippet, setSnippet] = useState<string | null>(null);
  const [snippetNote, setSnippetNote] = useState("");
  const [snippetOpen, setSnippetOpen] = useState(false);
  const splitRef = useRef<HTMLDivElement>(null);
  const splitDrag = useRef(false);

  const primary = contentType.schemaOrgType ?? null;
  const secondary = contentType.schemaOrgSecondary ?? null;
  const fields = contentType.definition.fields;
  // Includes relations inside components / dynamic zones (hand-off-02) — path identifies the edge
  const relationPaths = collectRelationPaths(contentType.definition, components);
  const targetNameOf = (uid: string) => types?.find((t) => t.uid === uid)?.name ?? uid;

  // Splitter drag
  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (!splitDrag.current || !splitRef.current) return;
      const rect = splitRef.current.getBoundingClientRect();
      const ratio = (e.clientX - rect.left) / rect.width;
      setPaneRatio(Math.min(0.75, Math.max(0.35, ratio)));
    };
    const up = () => { splitDrag.current = false; };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, []);

  // Field → property validation (reuses existing rules)
  const typesParam = [primary, secondary].filter(Boolean).join(",");
  const propsParam = candidateProps(contentType.definition).join(",");
  const { data: validData } = useQuery({
    queryKey: ["schema-org-validate", typesParam, propsParam],
    queryFn: () =>
      api<{ valid: Record<string, boolean> }>(
        `/api/schema-org/validate?types=${encodeURIComponent(typesParam)}&props=${encodeURIComponent(propsParam)}`,
      ),
    enabled: !!typesParam,
  });
  const fieldMap = buildFieldMap(contentType.definition, primary, typesParam ? (validData?.valid ?? null) : null);
  const emitted = fieldMap.filter((m) => m.prop !== null).length;
  const dropped = fieldMap.filter((m) => m.status === "dropped").length;

  const viewSnippet = async () => {
    setSnippetOpen(true);
    setSnippet(null);
    setSnippetNote("");
    try {
      const published = await api<{ items: Entry[] }>(
        `/api/content/${contentType.uid}?status=published&pageSize=1`,
      );
      const entry =
        published.items[0] ??
        (await api<{ items: Entry[] }>(`/api/content/${contentType.uid}?pageSize=1`)).items[0];
      if (!entry) {
        const sample = await api<{ jsonld: Record<string, unknown> | null }>(
          `/api/content-types/${contentType.uid}/jsonld-sample`,
        );
        setSnippet(JSON.stringify(sample.jsonld, null, 2));
        setSnippetNote("Sample shape — placeholder values. Create an entry for real data.");
        return;
      }
      const preview = await api<{ jsonld: Record<string, unknown> | null; status: string }>(
        `/api/content/${contentType.uid}/${entry.id}/jsonld-preview`,
      );
      setSnippet(JSON.stringify(preview.jsonld, null, 2));
      setSnippetNote(
        preview.status === "published"
          ? "Live — exactly what /delivery serves for this entry."
          : `Preview from a ${preview.status} entry — served once published.`,
      );
    } catch {
      setSnippet("// Failed to load snippet.");
    }
  };

  const selectedPath =
    selection.kind === "edge"
      ? relationPaths.find((rp) => rp.path === selection.fieldName)
      : undefined;
  const selectedField = selectedPath?.def;
  const selectedVia = selectedPath?.via ? components?.find((c) => c.uid === selectedPath.via) : undefined;

  return (
    <div className="sem-tab">
      <section className="sem-table">
        <div className="sem-table-intro">
          <div style={{ flex: 1, minWidth: "0" }}>
            <div className="fm-group-label">Relationship graph</div>
            <div className="sem-table-desc">
              The centre node is the subject — select it to say what it{" "}
              <strong style={{ fontFamily: "var(--font-sans)" }}>is</strong>. Every relation field
              is an object; select an edge to say how they relate. Drag any node to rearrange it,
              or drag the canvas to pan.
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "0.8rem", flex: "none" }}>
            <button className="kg-chip-btn" onClick={() => setResetToken((n) => n + 1)}>
              Reset layout
            </button>
          </div>
        </div>
        <div ref={splitRef} className="kg-split">
          <div className="kg-pane" style={{ flex: `0 0 ${paneRatio * 100}%` }}>
            <KgTypesCanvas
              types={types ?? []}
              components={components}
              currentUid={contentType.uid}
              showAll={showAll}
              onToggleShowAll={toggleShowAll}
              selection={selection}
              onSelect={setSelection}
              onOpenType={(uid) => navigate(`/ctb/${uid}?tab=semantic${showAll ? "&graph=all" : ""}`)}
              resetToken={resetToken}
            />
          </div>
          <div className="kg-divider" onPointerDown={() => { splitDrag.current = true; }}>
            <span className="kg-divider-grip" />
          </div>
          <div className="kg-inspector">
            {selection.kind === "contains" ? (
              <ContainsInspector
                key={selection.path ?? `${selection.fieldName}:${selection.component}`}
                contentType={contentType}
                selection={selection}
                components={components}
                parentTypes={[primary, secondary].filter((x): x is string => !!x)}
                onSave={onSave}
                onSaveComponent={(uid, patch) => updateComponent.mutate({ uid, patch })}
                onViewSnippet={() => void viewSnippet()}
              />
            ) : selection.kind === "self" ? (
              <SelfInspector
                contentType={contentType}
                primary={primary}
                secondary={secondary}
                onSave={onSave}
                emitted={emitted}
                total={fieldMap.length}
                dropped={dropped}
                onOpenFieldMap={() => setFmOpen(true)}
                onViewSnippet={() => void viewSnippet()}
              />
            ) : selectedField ? (
              <EdgeInspector
                key={selectedPath!.path}
                contentType={contentType}
                field={selectedField}
                via={selectedVia}
                targetName={targetNameOf(selectedField.target as string)}
                onSave={onSave}
                onSaveComponent={(uid, patch) => updateComponent.mutate({ uid, patch })}
                onViewSnippet={() => void viewSnippet()}
              />
            ) : null}
          </div>
        </div>
      </section>

      {fmOpen && (
        <div className="fm-backdrop" onClick={() => setFmOpen(false)}>
          <div className="fm" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Field → property">
            <div className="fm-head fm-head-add">
              <div style={{ flex: 1 }}>
                <div className="fm-title">Field → property</div>
                <div className="fm-sub">
                  Every field is emitted under a property of {primary ? `schema:${primary}` : "the primary type"}.
                </div>
              </div>
              <button className="fm-close" onClick={() => setFmOpen(false)} aria-label="Close">
                <IconX size="1.3rem" />
              </button>
            </div>
            <div className="fm-body" style={{ padding: "0" }}>
              <div className="sem-row sem-row-head sem-cols-map">
                <div>Field</div><div>schema.org property</div><div>Status</div>
              </div>
              {fieldMap.map((m) => (
                <div key={m.field.name} className="sem-row sem-cols-map">
                  <div className="sem-field-cell">
                    <FieldTypeTile type={m.field.type} />
                    <span className="sem-field-name">{m.field.label ?? m.field.name}</span>
                    <span className="sem-field-type">{TYPE_LABEL[m.field.type] ?? m.field.type}</span>
                  </div>
                  <div>
                    {m.prop ? (
                      <span className="sem-prop">{m.prop}</span>
                    ) : m.status === "dropped" ? (
                      <span className="sem-prop warn">dropped</span>
                    ) : (
                      <span className="sem-prop muted">—</span>
                    )}
                  </div>
                  <div className={m.status === "dropped" ? "sem-status-cell danger" : "sem-status-cell"}>
                    <span className="sem-dot" style={{ background: STATUS_DOT[m.status] }} />
                    <span>{m.statusLabel}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {snippetOpen && (
        <div className="fm-backdrop" onClick={() => setSnippetOpen(false)}>
          <div className="fm" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="JSON-LD snippet">
            <div className="fm-head fm-head-add">
              <div style={{ flex: 1 }}>
                <div className="fm-title">JSON-LD snippet</div>
                <div className="fm-sub">{snippetNote || `Latest ${contentType.name} entry.`}</div>
              </div>
              <button className="fm-close" onClick={() => setSnippetOpen(false)} aria-label="Close">
                <IconX size="1.3rem" />
              </button>
            </div>
            <div className="fm-body">
              <pre className="code-area readonly sem-snippet">{snippet ?? "Loading…"}</pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** subject inspector — declares the type's identity */
function SelfInspector({
  contentType,
  primary,
  secondary,
  onSave,
  emitted,
  total,
  dropped,
  onOpenFieldMap,
  onViewSnippet,
}: {
  contentType: ContentType;
  primary: string | null;
  secondary: string | null;
  onSave(patch: Record<string, unknown>): void;
  emitted: number;
  total: number;
  dropped: number;
  onOpenFieldMap(): void;
  onViewSnippet(): void;
}) {
  return (
    <div className="kg-panel">
      <div className="kg-panel-section">
        <div className="fm-group-label">Selected node · subject</div>
        <div className="kg-sentence">
          <strong>{contentType.name}</strong> is a{" "}
          <strong style={{ color: "var(--accent)" }}>{primary ? `schema:${primary}` : "…"}</strong>
        </div>
        <div className="kg-note">
          This is what every entry claims to be. Fields with no equivalent on this type quietly
          drop out of the JSON-LD.
        </div>
      </div>
      <div className="kg-panel-section">
        <div style={{ display: "flex", flexDirection: "column", gap: "1.4rem" }}>
          <SchemaCombobox label="Primary type" value={primary} onPick={(v) => onSave({ schemaOrgType: v })} />
          <SchemaCombobox label="Secondary type" value={secondary} allowNone onPick={(v) => onSave({ schemaOrgSecondary: v })} />
        </div>
      </div>
      <div className="kg-panel-section" style={{ borderBottom: "none" }}>
        <button className="kg-fm-banner" onClick={onOpenFieldMap}>
          <span className="sem-dot" style={{ background: dropped > 0 ? "var(--danger)" : "var(--published)" }} />
          <span style={{ flex: 1, minWidth: "0", textAlign: "left", display: "flex", flexDirection: "column", gap: "0.3rem" }}>
            <span className="kg-fm-title">{emitted} of {total} fields emitted</span>
            <span className="kg-fm-sub">
              {dropped > 0 ? `${dropped} dropped — open the field → property map` : "Field → property map"}
            </span>
          </span>
          <svg width="1.3rem" height="1.3rem" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.7" style={{ flex: "none" }}>
            <path d="M4.4 2.6 7.8 6l-3.4 3.4" />
          </svg>
        </button>
      </div>
      <div className="kg-panel-foot">
        <button className="kg-jsonld-btn" onClick={onViewSnippet}>
          <svg width="1.2rem" height="1.2rem" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M5.4 3.2 2.4 7l3 3.8M8.6 3.2 11.6 7l-3 3.8" />
          </svg>
          View JSON-LD snippet
        </button>
      </div>
    </div>
  );
}

const PLAIN_TYPES = new Set<string>([
  FieldType.Text, FieldType.Uid, FieldType.Richtext, FieldType.Number, FieldType.Boolean,
  FieldType.Date, FieldType.Enum, FieldType.Media,
]);

/** `acceptedAnswer/Answer.text` ⇄ wrap rule; anything else is a plain property name */
function encodeMapping(name: string, sem: SemanticMapping | undefined): string {
  const w = sem?.wrap?.[name];
  if (w) return `${w.property}/${w.schemaOrgType}.${w.valueProperty}`;
  return sem?.properties?.[name] ?? "";
}
function parseMapping(raw: string): { property: string } | { property: string; schemaOrgType: string; valueProperty: string } | null {
  const v = raw.trim();
  if (!v) return null;
  const m = /^([^/\s]+)\/([A-Za-z][\w]*)\.([A-Za-z][\w]*)$/.exec(v);
  if (m) return { property: m[1]!, schemaOrgType: m[2]!, valueProperty: m[3]! };
  return { property: v };
}

/**
 * Contains inspector (41-IMPL) — a dynamic zone / component field maps to JSON-LD in two parts:
 * the edge (which property of the parent node receives the blocks — saved on the field's owner) and
 * the node (what the carried component is — saved on the component, shared by every type using it).
 */
function ContainsInspector({
  contentType,
  selection,
  components,
  parentTypes,
  onSave,
  onSaveComponent,
  onViewSnippet,
}: {
  contentType: ContentType;
  selection: KgSelection;
  components: ComponentDef[] | undefined;
  /** The type's schema.org types — parent node types when the field is the type's own */
  parentTypes: string[];
  onSave(patch: Record<string, unknown>): void;
  onSaveComponent(uid: string, patch: Record<string, unknown>): void;
  onViewSnippet(): void;
}) {
  const through = selection.through ?? "zone";
  const component = components?.find((c) => c.uid === selection.component);
  const via = selection.via ? components?.find((c) => c.uid === selection.via) : undefined;
  const owner = via ? via.definition : contentType.definition;
  const field = owner.fields.find((f) => f.name === selection.fieldName);
  const parentSem = via?.definition.semantic;
  const parentNodeTypes = via
    ? [parentSem?.schemaOrgType, parentSem?.secondary].filter((x): x is string => !!x)
    : parentTypes;
  const parentLabel = via ? (parentSem?.schemaOrgType ? `schema:${parentSem.schemaOrgType}` : `${via.name} (no node — hoisted)`) : (parentTypes[0] ? `schema:${parentTypes[0]}` : "the type");

  const [predicate, setPredicate] = useState<string>((field?.predicate as string | undefined) ?? "");
  const sem = component?.definition.semantic;
  const [nodeType, setNodeType] = useState<string | null>(sem?.schemaOrgType ?? null);
  const plainFields = (component?.definition.fields ?? []).filter((f) => PLAIN_TYPES.has(f.type));
  const nestedFields = (component?.definition.fields ?? []).filter((f) => f.type === FieldType.Component || f.type === FieldType.DynamicZone);
  const [mapping, setMapping] = useState<Record<string, string>>(() =>
    Object.fromEntries(plainFields.map((f) => [f.name, encodeMapping(f.name, sem)])),
  );

  // Validity of the edge property on the parent, and of each mapped/implicit property on the node
  const edgeTypes = parentNodeTypes.join(",");
  const { data: edgeValid } = useQuery({
    queryKey: ["schema-org-validate", edgeTypes, predicate],
    queryFn: () => api<{ valid: Record<string, boolean> }>(`/api/schema-org/validate?types=${encodeURIComponent(edgeTypes)}&props=${encodeURIComponent(predicate)}`),
    enabled: !!edgeTypes && !!predicate && !predicate.includes(":"),
  });
  const nodeProps = plainFields.map((f) => { const p = parseMapping(mapping[f.name] ?? ""); return p ? p.property : f.name; });
  const nodePropsParam = [...new Set(nodeProps)].join(",");
  const { data: nodeValid } = useQuery({
    queryKey: ["schema-org-validate", nodeType ?? "", nodePropsParam],
    queryFn: () => api<{ valid: Record<string, boolean> }>(`/api/schema-org/validate?types=${encodeURIComponent(nodeType ?? "")}&props=${encodeURIComponent(nodePropsParam)}`),
    enabled: !!nodeType && nodePropsParam.length > 0,
  });

  const edgeDirty = predicate !== ((field?.predicate as string | undefined) ?? "");
  const nodeDirty =
    nodeType !== (sem?.schemaOrgType ?? null) ||
    plainFields.some((f) => (mapping[f.name] ?? "") !== encodeMapping(f.name, sem));

  const save = () => {
    if (!component || !field) return;
    if (edgeDirty) {
      const nextFields = owner.fields.map((f) => (f.name === field.name ? { ...f, predicate: predicate || undefined } : f));
      if (via) onSaveComponent(via.uid, { definition: { ...owner, fields: nextFields } });
      else onSave({ definition: { ...owner, fields: nextFields } });
    }
    if (nodeDirty) {
      const properties: Record<string, string> = {};
      const wrap: NonNullable<SemanticMapping["wrap"]> = {};
      for (const f of plainFields) {
        const p = parseMapping(mapping[f.name] ?? "");
        if (!p) continue;
        if ("schemaOrgType" in p) wrap[f.name] = p;
        else properties[f.name] = p.property;
      }
      const next: SemanticMapping = {
        ...(nodeType ? { schemaOrgType: nodeType } : {}),
        ...(Object.keys(properties).length ? { properties } : {}),
        ...(Object.keys(wrap).length ? { wrap } : {}),
      };
      const def = { ...component.definition };
      if (Object.keys(next).length) def.semantic = next;
      else delete def.semantic;
      onSaveComponent(component.uid, { definition: def });
    }
  };

  const edgeStatus = !predicate
    ? { dot: "var(--text-3)", text: "no property — the blocks stay out of JSON-LD (legacy additionalProperty if valid)" }
    : predicate.includes(":")
      ? { dot: "var(--accent)", text: "external vocab — kept" }
      : edgeValid?.valid[predicate]
        ? { dot: "var(--published)", text: `valid on ${parentLabel}` }
        : { dot: "var(--accent)", text: "custom property — kept via @context" };

  return (
    <div className="kg-panel">
      <div className="kg-panel-section">
        <div className="fm-group-label">{through === "zone" ? "Dynamic zone" : "Component field"}</div>
        <div className="kg-sentence">
          <strong>{via ? via.name : contentType.name}</strong>{" "}
          <span className="kg-verb">{predicate || (through === "zone" ? "may contain" : "contains")}</span>{" "}
          <strong>{component?.name ?? "component"}</strong>
        </div>
        <div className="kg-via">via {selection.path ?? selection.fieldName}</div>
        {via && (
          <div className="widget-hint" style={{ marginTop: "0.6rem" }}>
            inside component <code>{via.uid}</code> — saved on that component, shared by every type that uses it
          </div>
        )}
      </div>

      <div className="kg-panel-section">
        <div className="kg-panel-label">Property on {parentLabel}</div>
        <PredicateInput value={predicate} onChange={(v) => setPredicate(v ?? "")} />
        <div className="kg-note" style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
          <span className="sem-dot" style={{ background: edgeStatus.dot }} />
          <span>{edgeStatus.text}</span>
        </div>
      </div>

      {component && (
        <div className="kg-panel-section">
          <div className="kg-panel-label">{component.name} node</div>
          <SchemaCombobox label="@type" value={nodeType} allowNone onPick={setNodeType} />
          <div className="kg-note">
            {nodeType
              ? `Each block becomes a schema:${nodeType} node under the property above.`
              : "No node — the component is a wrapper: only its own mapped component / zone fields pass through to the parent (select their dashed edges)."}
          </div>
        </div>
      )}

      {component && nodeType && plainFields.length > 0 && (
        <div className="kg-panel-section">
          <div className="kg-panel-label">Field → property on schema:{nodeType}</div>
          <div className="sem-node-map">
            {plainFields.map((f) => {
              const parsed = parseMapping(mapping[f.name] ?? "");
              const prop = parsed ? parsed.property : f.name;
              const valid = nodeValid?.valid[prop];
              const dot = !parsed && !valid ? "var(--danger)" : prop.includes(":") || valid ? (valid ? "var(--published)" : "var(--accent)") : "var(--accent)";
              const label = parsed
                ? "schemaOrgType" in parsed
                  ? `wrapped as ${parsed.schemaOrgType}.${parsed.valueProperty}`
                  : valid ? "mapped" : "custom — kept via @context"
                : valid ? "field name is a valid property" : "dropped — map it or rename the field";
              return (
                <div key={f.name} className="sem-node-row">
                  <div className="sem-field-cell">
                    <FieldTypeTile type={f.type} />
                    <span className="sem-field-name">{f.label ?? f.name}</span>
                  </div>
                  <input
                    className="sem-node-input"
                    value={mapping[f.name] ?? ""}
                    placeholder={f.name}
                    spellCheck={false}
                    onChange={(e) => setMapping((m) => ({ ...m, [f.name]: e.target.value }))}
                  />
                  <div className="sem-status-cell" title={label}>
                    <span className="sem-dot" style={{ background: dot }} />
                    <span>{label}</span>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="kg-note">
            Empty = the field name. <code>property/Type.valueProperty</code> wraps the value in a node, e.g.{" "}
            <code>acceptedAnswer/Answer.text</code>.
          </div>
        </div>
      )}

      {component && nestedFields.length > 0 && (
        <div className="kg-panel-section">
          <div className="kg-panel-label">Nested</div>
          <div className="kg-note">
            {nestedFields.map((f) => <code key={f.name} style={{ marginRight: "0.6rem" }}>{f.name}</code>)}
            — select their dashed edges on the canvas to map them{nodeType ? ` under schema:${nodeType}` : " onto the parent (hoisted)"}.
          </div>
        </div>
      )}

      <div className="kg-panel-foot">
        <button className="btn btn-primary" style={{ flex: 1, height: "3.4rem", justifyContent: "center" }} disabled={!(edgeDirty || nodeDirty) || !component || !field} onClick={save}>
          Save mapping
        </button>
        <button className="btn" style={{ height: "3.4rem" }} onClick={onViewSnippet}>
          JSON-LD
        </button>
      </div>
    </div>
  );
}

/** edge inspector — the relation's meaning + inverse write-back */

function EdgeInspector({
  contentType,
  field,
  via,
  targetName,
  onSave,
  onSaveComponent,
  onViewSnippet,
}: {
  contentType: ContentType;
  field: FieldDef;
  /** Set when the relation lives inside a component — the predicate is saved on that component */
  via?: ComponentDef;
  targetName: string;
  onSave(patch: Record<string, unknown>): void;
  onSaveComponent(uid: string, patch: Record<string, unknown>): void;
  onViewSnippet(): void;
}) {
  const [predicate, setPredicate] = useState<string>((field.predicate as string) ?? "");
  const [writeInverse, setWriteInverse] = useState<boolean>(field.writeInverse === true);
  const dirty =
    predicate !== ((field.predicate as string) ?? "") ||
    writeInverse !== (field.writeInverse === true);

  // Suggest the standard inverse predicate (inv_ prefix when none exists)
  const { data: invData } = useQuery({
    queryKey: ["schema-org-inverse", predicate],
    queryFn: () =>
      api<{ inverse: string | null }>(`/api/schema-org/inverse?prop=${encodeURIComponent(predicate)}`),
    enabled: !!predicate && !predicate.includes(":"),
  });
  const inverseName =
    (field.inversePredicate as string | undefined) && !dirty
      ? (field.inversePredicate as string)
      : (invData?.inverse ?? (predicate ? `inv_${predicate}` : ""));

  const saveEdge = () => {
    const owner = via ? via.definition : contentType.definition;
    const nextFields = owner.fields.map((f) =>
      f.name === field.name
        ? {
            ...f,
            predicate: predicate || undefined,
            inversePredicate: writeInverse ? inverseName : undefined,
            writeInverse: writeInverse || undefined,
          }
        : f,
    );
    if (via) onSaveComponent(via.uid, { definition: { ...owner, fields: nextFields } });
    else onSave({ definition: { ...owner, fields: nextFields } });
  };

  return (
    <div className="kg-panel">
      <div className="kg-panel-section">
        <div className="fm-group-label">Selected edge</div>
        <div className="kg-sentence">
          <strong>{contentType.name}</strong>{" "}
          <span className="kg-verb">{predicate || "relates to"}</span>{" "}
          <strong>{targetName}</strong>
        </div>
        {via && (
          <div className="widget-hint" style={{ marginTop: "0.6rem" }}>
            inside component <code>{via.uid}</code> — saved on the component, shared by every type that uses it
          </div>
        )}
        <div className="kg-via">via {field.name}</div>
      </div>
      <div className="kg-panel-section">
        <div className="kg-panel-label">Relationship</div>
        <PredicateInput value={predicate} onChange={(v) => setPredicate(v ?? "")} />
      </div>
      <div className="kg-panel-section" style={{ borderBottom: "none" }}>
        <div className="kg-panel-label">Inverse on {targetName}</div>
        <button
          type="button"
          className={writeInverse ? "kg-inverse on" : "kg-inverse"}
          onClick={() => setWriteInverse((v) => !v)}
          disabled={!predicate}
        >
          <span style={{ flex: 1, textAlign: "left" }}>
            Write <strong className="mono">{inverseName || "…"}</strong> back automatically
          </span>
          <span className={writeInverse ? "mini-switch" : "mini-switch off"} aria-hidden />
        </button>
        <div className="kg-note">
          {writeInverse
            ? `Published ${targetName} entries will also emit ${inverseName} pointing back here.`
            : "Off — the relation is only emitted from this side."}
        </div>
      </div>
      <div className="kg-panel-foot">
        <button className="btn btn-primary" style={{ flex: 1, height: "3.4rem", justifyContent: "center" }} disabled={!dirty} onClick={saveEdge}>
          Save edge
        </button>
        <button className="btn" style={{ height: "3.4rem" }} onClick={onViewSnippet}>
          JSON-LD
        </button>
      </div>
    </div>
  );
}
