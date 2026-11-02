/** Edit field tab bodies — Basic / Validation / Advanced (design EDIT FIELD modal) */
import { FieldType, type ComponentDef, type FieldDef } from "../../../api/types";
import { FieldTypeTile } from "../../../components/common/FieldTypeTile";
import { ReviewNote, Switch } from "./ui";
import { PredicateInput } from "../semantic/PredicateInput";

export interface TabProps {
  def: FieldDef;
  set(k: string, v: unknown): void;
  isNew: boolean;
  typeUid: string;
  /** All fields of the type being edited (uid targetField candidates) */
  typeFields: FieldDef[];
  components: ComponentDef[];
  typeUids: string[];
  onDelete?: () => void;
}

const numOrUndef = (s: string) => (s === "" ? undefined : Number(s));

function NumInput({
  label, value, placeholder, onChange,
}: { label: string; value: unknown; placeholder?: string; onChange(v: number | undefined): void }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        className="mono" type="number" value={(value as number) ?? ""}
        placeholder={placeholder ?? "none"}
        onChange={(e) => onChange(numOrUndef(e.target.value))}
      />
    </label>
  );
}

/** Three ghost entry rows — LINKED from the top up to linkedCount (design relLeftRows/relRightRows) */
function RelEntryCard({
  label,
  linked,
  shortRow,
}: {
  label: string;
  linked: (i: number) => boolean;
  /** Row index that gets the short bar (the design's 62% bar) */
  shortRow: number;
}) {
  return (
    <div className="rel-ecard">
      <span className="rel-ecard-label">{label}</span>
      {[0, 1, 2].map((i) => (
        <span key={i} className={linked(i) ? "rel-erow on" : "rel-erow"}>
          <span className={i === shortRow ? "rel-erow-bar short" : "rel-erow-bar"} />
          {linked(i) && <b>LINKED</b>}
        </span>
      ))}
      <span className="rel-ehint">entries</span>
    </div>
  );
}

/**
 * Relation settings (design Prina New Field Modal — Target chip + Relation shape container).
 * Two axes folded into a single relationKind: count (one/many) × exclusivity (exclusive) → 4 kinds.
 */
function RelationNature({
  def,
  set,
  isNew,
  typeUid,
  typeUids,
}: {
  def: FieldDef;
  set(k: string, v: unknown): void;
  isNew: boolean;
  typeUid: string;
  typeUids: string[];
}) {
  const kind = (def.relationKind as string) ?? "manyToOne";
  const hasMany = kind === "manyToMany" || kind === "oneToMany";
  const exclusive = kind === "oneToOne" || kind === "oneToMany";
  const target = (def.target as string) ?? "";
  const shown = target || "target";
  const pick = (many: boolean, excl: boolean) =>
    set("relationKind", many ? (excl ? "oneToMany" : "manyToMany") : (excl ? "oneToOne" : "manyToOne"));

  const pickTarget = (t: string) => {
    const prevAuto = target.replace(/-/g, "_");
    set("target", t);
    if (isNew && (!def.name || def.name === prevAuto)) set("name", t.replace(/-/g, "_"));
  };

  const sentence = hasMany
    ? exclusive
      ? `One ${typeUid} holds many ${shown} entries, and each of those belongs to that ${typeUid} alone.`
      : `One ${typeUid} holds many ${shown} entries, and each of those can be shared across ${typeUid} entries.`
    : exclusive
      ? `One ${typeUid} points to a single ${shown}, and that entry belongs to this ${typeUid} only.`
      : `One ${typeUid} points to a single ${shown}, which many ${typeUid} entries may share.`;

  return (
    <>
      <div className="fm-group">
        <div className="field"><span>Target type</span></div>
        <div className="rel-chips">
          {typeUids.map((u) => (
            <button
              key={u}
              className={u === target ? "rel-chip on" : "rel-chip"}
              onClick={() => pickTarget(u)}
            >
              {u}
            </button>
          ))}
        </div>
      </div>

      <div className="fm-group">
        <div className="field"><span>Relation shape</span></div>
        <div className="rel-shape">
          <div className="rel-shape-diagram">
            <RelEntryCard
              label={`This type · ${typeUid}`}
              linked={(i) => i === 0}
              shortRow={1}
            />
            <div className="rel-connector">
              <span className="rel-node">{exclusive ? "1" : "N"}</span>
              <i className="rel-wire" />
              <span className="rel-node">{hasMany ? "N" : "1"}</span>
            </div>
            <RelEntryCard
              label={`Target type · ${shown}`}
              linked={(i) => i === 0 || (hasMany && i === 1)}
              shortRow={2}
            />
          </div>
          <div className="rel-shape-controls">
            <div className="rel-pill">
              <button className={hasMany ? "" : "active"} onClick={() => pick(false, exclusive)}>
                has one
              </button>
              <button className={hasMany ? "active" : ""} onClick={() => pick(true, exclusive)}>
                has many
              </button>
            </div>
            <span className="rel-divider" />
            <span className="switch-row-text">
              <span className="switch-row-label">Exclusive</span>
              <span className="switch-row-desc">
                One {shown} can be linked from only one {typeUid}
              </span>
            </span>
            <button
              type="button"
              className={exclusive ? "switch on" : "switch"}
              role="switch" aria-checked={exclusive} aria-label="Exclusive"
              onClick={() => pick(hasMany, !exclusive)}
            >
              <span className="switch-knob" />
            </button>
          </div>
          <div className="rel-shape-summary">
            <span>{sentence}</span>
            <code className="rel-code">{kind}</code>
          </div>
        </div>
      </div>
    </>
  );
}

export function BasicTab({ def, set, isNew, typeUid, typeFields, components, typeUids }: TabProps) {
  return (
    <div className="fm-pane">
      <div className="fm-name-row">
        <label className="field">
          <span>Field name</span>
          <input
            value={def.name} disabled={!isNew} placeholder="e.g. price"
            onChange={(e) => set("name", e.target.value)}
          />
        </label>
        <Switch
          on={def.required === true} label="Required"
          desc="Entries cannot leave draft without it"
          onToggle={() => set("required", def.required ? undefined : true)}
        />
      </div>

      {def.type === FieldType.Text && (
        <div className="fm-group">
          <div className="field"><span>Type</span></div>
          <div className="fm-grid-2">
            {[
              { multiline: false, label: "Short text", desc: "Single line — names, SKUs, labels" },
              { multiline: true, label: "Long text", desc: "Multi-line textarea, no formatting" },
            ].map((o) => {
              const on = (def.multiline === true) === o.multiline;
              return (
                <button
                  key={o.label} className={on ? "opt-card on" : "opt-card"}
                  onClick={() => set("multiline", o.multiline || undefined)}
                >
                  <FieldTypeTile type={FieldType.Text} />
                  <span className="opt-card-text">
                    <span className="opt-card-name">{o.label}</span>
                    <span className="opt-card-desc">{o.desc}</span>
                  </span>
                  <span className="opt-radio" />
                </button>
              );
            })}
          </div>
        </div>
      )}

      {def.type === FieldType.Uid && (
        <label className="field">
          <span>Derived from</span>
          <select
            value={(def.targetField as string) ?? ""}
            onChange={(e) => set("targetField", e.target.value || undefined)}
          >
            <option value="">None — entered manually</option>
            {typeFields
              .filter((f) => f.type === FieldType.Text && f.name !== def.name)
              .map((f) => (
                <option key={f.name} value={f.name}>{f.label ?? f.name}</option>
              ))}
          </select>
        </label>
      )}

      {def.type === FieldType.Enum && (
        <label className="field">
          <span>Options (comma-separated)</span>
          {/* Parsing on every keystroke makes commas impossible to type — parse on blur */}
          <input
            defaultValue={((def.options as string[]) ?? []).join(", ")}
            placeholder="Draft, Review, Published"
            onBlur={(e) =>
              set("options", e.target.value.split(",").map((s) => s.trim()).filter(Boolean))
            }
          />
        </label>
      )}

      {def.type === FieldType.Date && (
        <Switch
          on={def.withTime === true} label="With time"
          desc="Store a datetime instead of a plain date"
          onToggle={() => set("withTime", def.withTime ? undefined : true)}
        />
      )}

      {def.type === FieldType.Media && (
        <Switch
          on={def.multiple === true} label="Multiple assets"
          desc="A gallery instead of a single file — min/max live on Validation"
          onToggle={() => set("multiple", def.multiple ? undefined : true)}
        />
      )}

      {def.type === FieldType.Relation && (
        <RelationNature def={def} set={set} isNew={isNew} typeUid={typeUid} typeUids={typeUids} />
      )}

      {def.type === FieldType.Component && (
        <>
          <label className="field">
            <span>Component</span>
            <select value={(def.component as string) ?? ""} onChange={(e) => set("component", e.target.value)}>
              <option value="">Select…</option>
              {components.map((c) => <option key={c.uid} value={c.uid}>{c.name}</option>)}
            </select>
          </label>
          <Switch
            on={def.repeatable === true} label="Repeatable"
            desc="Editors can add the group multiple times"
            onToggle={() => set("repeatable", def.repeatable ? undefined : true)}
          />
        </>
      )}

      {def.type === FieldType.VariantAxis && (
        <label className="field">
          <span>Axes — one per line as "name: option1, option2"</span>
          <textarea
            rows={3}
            defaultValue={
              ((def.axes as Array<{ name: string; options: string[] }>) ?? [])
                .map((a) => `${a.name}: ${a.options.join(", ")}`).join("\n")
            }
            placeholder={"Colour: Red, Blue\nSize: S, M, L"}
            onBlur={(e) => {
              const axes = e.target.value.split("\n").map((l) => l.trim()).filter(Boolean)
                .map((line) => {
                  const [name, opts] = line.split(":");
                  return {
                    name: name!.trim(),
                    options: (opts ?? "").split(",").map((s) => s.trim()).filter(Boolean),
                  };
                })
                .filter((a) => a.name && a.options.length > 0);
              set("axes", axes);
            }}
          />
        </label>
      )}
    </div>
  );
}

export function ValidationTab({ def, set, components }: TabProps) {
  const noConstraints = ![
    FieldType.Text, FieldType.Uid, FieldType.Number, FieldType.Media,
    FieldType.Relation, FieldType.DynamicZone,
  ].includes(def.type);

  return (
    <div className="fm-pane">
      {def.type === FieldType.Uid && (
        <div className="fm-info">
          UID values are <strong>always unique</strong> — saving a duplicate is rejected.
          Allowed characters: lowercase letters, digits, <code>-</code> and <code>_</code>.
          Leave the value empty on an entry to derive it from the source field.
        </div>
      )}
      {def.type === FieldType.Text && (
        <div className="fm-fields-2">
          <NumInput label="Min length" value={def.minLength} onChange={(v) => set("minLength", v)} />
          <NumInput label="Max length" value={def.maxLength} onChange={(v) => set("maxLength", v)} />
          <label className="field fm-span-2">
            <span>Regex pattern</span>
            <input
              className="mono" value={(def.pattern as string) ?? ""} placeholder="^[\w\s\-]+$"
              onChange={(e) => set("pattern", e.target.value || undefined)}
            />
          </label>
        </div>
      )}

      {def.type === FieldType.Number && (
        <div className="fm-fields-3">
          <NumInput label="Minimum" value={def.min} onChange={(v) => set("min", v)} />
          <NumInput label="Maximum" value={def.max} onChange={(v) => set("max", v)} />
          <div className="field">
            <span>Precision</span>
            <div style={{ height: "4.2rem", display: "flex", alignItems: "center" }}>
              <Switch
                on={def.integer === true} label="Integer only"
                onToggle={() => set("integer", def.integer ? undefined : true)}
              />
            </div>
          </div>
        </div>
      )}

      {def.type === FieldType.Media && (def.multiple === true ? (
        <div className="fm-fields-2">
          <NumInput label="Minimum assets" value={def.min} onChange={(v) => set("min", v)} />
          <NumInput label="Maximum assets" value={def.max} onChange={(v) => set("max", v)} />
          <label className="field fm-span-2">
            <span>Allowed MIME types (comma-separated, empty = all)</span>
            <input
              className="mono" defaultValue={((def.allowedMimeTypes as string[]) ?? []).join(", ")}
              placeholder="image/jpeg, image/png, image/webp"
              onBlur={(e) =>
                set("allowedMimeTypes",
                  e.target.value ? e.target.value.split(",").map((s) => s.trim()).filter(Boolean) : undefined)
              }
            />
          </label>
        </div>
      ) : (
        <div className="fm-info">
          Count constraints apply to galleries — enable <strong>Multiple assets</strong> on
          the Basic tab to set minimum and maximum.
        </div>
      ))}

      {def.type === FieldType.Relation && (
        <div className="fm-fields-2">
          <div className="field">
            <span>Cardinality</span>
            <div className="fm-readonly">{(def.relationKind as string) ?? "—"}</div>
          </div>
          <div className="field">
            <span>Predicate (KG slot)</span>
            <PredicateInput
              value={(def.predicate as string) ?? ""}
              onChange={(v) => set("predicate", v)}
            />
          </div>
        </div>
      )}

      {def.type === FieldType.DynamicZone && (
        <div className="fm-group">
          <div className="field"><span>Allowed components</span></div>
          <div className="fm-grid-2">
            {components.map((c) => {
              const cur = (def.components as string[]) ?? [];
              const on = cur.includes(c.uid);
              return (
                <button
                  key={c.uid} className={on ? "opt-card on" : "opt-card"}
                  onClick={() =>
                    set("components", on ? cur.filter((u) => u !== c.uid) : [...cur, c.uid])
                  }
                >
                  <FieldTypeTile type={FieldType.Component} />
                  <span className="opt-card-text">
                    <span className="opt-card-name">{c.name}</span>
                    <span className="opt-card-desc">{c.definition.fields.length} fields · {c.uid}</span>
                  </span>
                </button>
              );
            })}
            {components.length === 0 && (
              <div className="fm-info fm-span-2">No components yet — create one first.</div>
            )}
          </div>
        </div>
      )}

      {noConstraints && (
        <div className="fm-info">
          This type has no numeric or pattern constraints — required is set on the Basic tab.
        </div>
      )}

      <ReviewNote>
        Tightening a rule does not invalidate existing entries — they keep their values and
        surface in the completeness column instead.
      </ReviewNote>
    </div>
  );
}

export function AdvancedTab({ def, set, isNew, typeUid, onDelete }: TabProps) {
  return (
    <div className="fm-pane">
      <div className="fm-fields-2">
        <div className="field">
          <span>API identifier</span>
          <div className="fm-readonly">{typeUid}.{def.name || "…"}</div>
        </div>
        <label className="field">
          <span>Display label</span>
          <input
            value={(def.label as string) ?? ""} placeholder={def.name || "Same as field name"}
            onChange={(e) => set("label", e.target.value || undefined)}
          />
        </label>
      </div>

      <label className="field">
        <span>Help text shown to editors</span>
        <input
          value={(def.description as string) ?? ""}
          placeholder="Optional — appears under the input in Content Manager"
          onChange={(e) => set("description", e.target.value || undefined)}
        />
      </label>

      <div className="fm-adv-toggles">
        {def.type === FieldType.Text && (
          <Switch
            on={def.unique === true} label="Unique"
            desc="No two entries of this type may share the value"
            onToggle={() => set("unique", def.unique ? undefined : true)}
          />
        )}
        {def.type === FieldType.Media && (
          <Switch
            on={def.altText === true} label="Alt text"
            desc="Editors describe each image for screen readers (a11y). Alt is stored on the asset and reused everywhere"
            onToggle={() => set("altText", def.altText ? undefined : true)}
          />
        )}
        <Switch
          on={def.localized === true} label="Localizable"
          desc="Separate value per locale — also the default selection for Translate with AI"
          onToggle={() => set("localized", def.localized ? undefined : true)}
        />
      </div>

      {!isNew && onDelete && (
        <button className="btn-danger-outline" onClick={onDelete}>Delete this field</button>
      )}
    </div>
  );
}
