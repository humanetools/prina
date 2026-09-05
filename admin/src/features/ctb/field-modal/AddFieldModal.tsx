/** Add field step 1 — type picker grid (design ADD FIELD modal) */
import { useState } from "react";
import { IconX } from "@tabler/icons-react";
import type { FieldType } from "../../../api/types";
import { FieldTypeTile } from "../../../components/common/FieldTypeTile";
import { FIELD_GROUPS, TYPE_LABEL } from "./meta";

export function AddFieldModal({
  typeName,
  excludeTypes,
  onPick,
  onClose,
}: {
  typeName: string;
  /** Types hidden from the picker (component editing: non-nestable types) */
  excludeTypes?: FieldType[];
  onPick(type: FieldType): void;
  onClose(): void;
}) {
  const [picked, setPicked] = useState<FieldType | null>(null);
  const groups = FIELD_GROUPS
    .map((g) => ({
      ...g,
      items: g.items.filter((it) => !excludeTypes?.includes(it.type)),
    }))
    .filter((g) => g.items.length > 0);

  return (
    <div className="fm-backdrop" onClick={onClose}>
      <div className="fm fm-add" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Add field">
        <div className="fm-head fm-head-add">
          <div style={{ flex: 1 }}>
            <div className="fm-title">Add a field to {typeName}</div>
            <div className="fm-sub">Pick a type — naming and validation come on the next step.</div>
          </div>
          <button className="fm-close" onClick={onClose} aria-label="Close"><IconX size="1.3rem" /></button>
        </div>

        <div className="fm-body fm-body-add">
          {groups.map((g) => (
            <div key={g.label} className="fm-group">
              <div className="fm-group-label">{g.label}</div>
              <div className="fm-grid-4">
                {g.items.map((it) => (
                  <button
                    key={it.type}
                    className={picked === it.type ? "opt-card on" : "opt-card"}
                    onClick={() => setPicked(it.type)}
                    onDoubleClick={() => onPick(it.type)}
                  >
                    <FieldTypeTile type={it.type} />
                    <span className="opt-card-text">
                      <span className="opt-card-name">{TYPE_LABEL[it.type]}</span>
                      <span className="opt-card-desc">{it.desc}</span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="fm-foot">
          {picked ? (
            <span className="fm-foot-sel">
              Selected · <strong>{TYPE_LABEL[picked]}</strong>
            </span>
          ) : (
            <span className="fm-foot-spacer" />
          )}
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!picked} onClick={() => picked && onPick(picked)}>
            Configure field
          </button>
        </div>
      </div>
    </div>
  );
}
