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
import { FieldType, type ContentType, type Entry, type FieldDef } from "../../../api/types";
import { FieldTypeTile } from "../../../components/common/FieldTypeTile";
import { TYPE_LABEL } from "../field-modal/meta";
import { useContentTypes } from "../../../hooks/queries";
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
  const relationFields = fields.filter((f) => f.type === FieldType.Relation);
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

  const selectedField =
    selection.kind === "edge"
      ? relationFields.find((f) => f.name === selection.fieldName)
      : undefined;

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
            {selection.kind === "self" ? (
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
                key={selectedField.name}
                contentType={contentType}
                field={selectedField}
                targetName={targetNameOf(selectedField.target as string)}
                onSave={onSave}
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

/** edge inspector — the relation's meaning + inverse write-back */
function EdgeInspector({
  contentType,
  field,
  targetName,
  onSave,
  onViewSnippet,
}: {
  contentType: ContentType;
  field: FieldDef;
  targetName: string;
  onSave(patch: Record<string, unknown>): void;
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
    const nextFields = contentType.definition.fields.map((f) =>
      f.name === field.name
        ? {
            ...f,
            predicate: predicate || undefined,
            inversePredicate: writeInverse ? inverseName : undefined,
            writeInverse: writeInverse || undefined,
          }
        : f,
    );
    onSave({ definition: { ...contentType.definition, fields: nextFields } });
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
