/** Edit field step 2 — tabbed modal shell (design EDIT FIELD modal) */
import { useState } from "react";
import { IconX } from "@tabler/icons-react";
import { FieldType, type ComponentDef, type FieldDef } from "../../../api/types";
import { FieldTypeTile } from "../../../components/common/FieldTypeTile";
import { TYPE_LABEL, fieldRuleSummary } from "./meta";
import { AdvancedTab, BasicTab, ValidationTab, type TabProps } from "./edit-tabs";

type TabKey = "basic" | "validation" | "advanced";

const TABS: Array<[TabKey, string]> = [
  ["basic", "Basic"],
  ["validation", "Validation"],
  ["advanced", "Advanced"],
];

const NAME_RE = /^[a-z][a-zA-Z0-9_]{0,63}$/;

export function FieldEditModal({
  initial,
  newType,
  initialTab,
  typeUid,
  typeFields,
  components,
  typeUids,
  onSave,
  onAddAnother,
  onDelete,
  onClose,
}: {
  /** null means new (created via newType) */
  initial: FieldDef | null;
  newType?: FieldType;
  /** Tab to activate on open (e.g. Predicate table Edit → validation) */
  initialTab?: "basic" | "validation" | "advanced";
  typeUid: string;
  typeFields: FieldDef[];
  components: ComponentDef[];
  typeUids: string[];
  onSave(def: FieldDef): void;
  onAddAnother(def: FieldDef): void;
  onDelete?: (name: string) => void;
  onClose(): void;
}) {
  const isNew = initial === null;
  const [tab, setTab] = useState<TabKey>(initialTab ?? "basic");
  const [def, setDef] = useState<FieldDef>(
    initial ?? {
      name: "",
      type: newType ?? FieldType.Text,
      // New fields start Localizable — per-locale values are the norm; opting out is the exception
      localized: true,
      // relationKind is required by the server defSchema — kept in sync with the picker's default selection
      ...(newType === FieldType.Relation ? { relationKind: "manyToOne" } : {}),
    },
  );
  const set = (k: string, v: unknown) => setDef((d) => ({ ...d, [k]: v }));

  /** Reason saving is blocked — null means savable. Shown as-is in the footer */
  const invalidReason = !NAME_RE.test(def.name)
    ? def.name
      ? "Field name must start with a lowercase letter (letters, digits, _)"
      : "Enter a field name"
    : def.type === FieldType.Relation && !def.target
      ? "Pick a target type"
      : def.type === FieldType.Component && !def.component
        ? "Pick a component"
        : def.type === FieldType.Enum && ((def.options as string[]) ?? []).length === 0
          ? "Add at least one option"
          : def.type === FieldType.VariantAxis && ((def.axes as unknown[]) ?? []).length === 0
            ? "Define at least one axis"
            : null;
  const valid = invalidReason === null;

  const tabProps: TabProps = {
    def, set, isNew, typeUid, typeFields, components, typeUids,
    onDelete: onDelete ? () => onDelete(def.name) : undefined,
  };

  return (
    <div className="fm-backdrop" onClick={onClose}>
      <div className="fm" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Edit field">
        <div className="fm-head">
          <FieldTypeTile type={def.type} />
          <div style={{ flex: 1, minWidth: "0" }}>
            <div className="fm-title">{def.name || "New field"}</div>
            <div className="fm-sub" style={{ marginTop: "0.5rem" }}>
              {TYPE_LABEL[def.type]} · {fieldRuleSummary(def)}
            </div>
          </div>
          <button className="fm-close" onClick={onClose} aria-label="Close"><IconX size="1.3rem" /></button>
        </div>

        <div className="fm-tabs">
          {TABS.map(([key, label]) => (
            <button
              key={key}
              className={tab === key ? "fm-tab on" : "fm-tab"}
              onClick={() => setTab(key)}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="fm-body">
          {tab === "basic" && <BasicTab {...tabProps} />}
          {tab === "validation" && <ValidationTab {...tabProps} />}
          {tab === "advanced" && <AdvancedTab {...tabProps} />}
        </div>

        <div className="fm-foot">
          <button className="btn" onClick={onClose}>Cancel</button>
          {invalidReason ? (
            <span className="fm-foot-reason">{invalidReason}</span>
          ) : (
            <span className="fm-foot-spacer" />
          )}
          <button className="btn btn-ai-soft" disabled={!valid} onClick={() => onAddAnother(def)}>
            + Add another field
          </button>
          <button className="btn btn-primary" disabled={!valid} onClick={() => onSave(def)}>
            Save field
          </button>
        </div>
      </div>
    </div>
  );
}
