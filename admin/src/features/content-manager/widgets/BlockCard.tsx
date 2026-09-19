/** Collapsible block card — one dynamic-zone block / repeatable-component item (Strapi-style stack) */
import type { ReactNode } from "react";
import { IconArrowDown, IconArrowUp, IconChevronDown, IconCopy, IconTrash } from "@tabler/icons-react";
import { FieldTypeTile } from "../../../components/common/FieldTypeTile";

export function BlockCard({
  title,
  summary,
  open,
  onToggle,
  canMoveUp,
  canMoveDown,
  onMoveUp,
  onMoveDown,
  onDuplicate,
  onRemove,
  children,
}: {
  title: string;
  /** Collapsed preview — first text value of the block */
  summary?: string;
  open: boolean;
  onToggle(): void;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMoveUp(): void;
  onMoveDown(): void;
  onDuplicate?(): void;
  onRemove(): void;
  children: ReactNode;
}) {
  return (
    <div className={open ? "dz-block open" : "dz-block"}>
      <div className="dz-block-head">
        <button type="button" className="dz-caret" onClick={onToggle} aria-expanded={open} title={open ? "Collapse" : "Expand"}>
          <IconChevronDown size="1.4rem" />
        </button>
        <FieldTypeTile type="component" />
        <button type="button" className="dz-block-title" onClick={onToggle}>
          <b>{title}</b>
          {!open && summary && <span className="dz-block-summary">{summary}</span>}
        </button>
        <div className="dz-block-actions">
          <button type="button" className="dz-act" disabled={!canMoveUp} onClick={onMoveUp} title="Move up"><IconArrowUp size="1.3rem" /></button>
          <button type="button" className="dz-act" disabled={!canMoveDown} onClick={onMoveDown} title="Move down"><IconArrowDown size="1.3rem" /></button>
          {onDuplicate && (
            <button type="button" className="dz-act" onClick={onDuplicate} title="Duplicate"><IconCopy size="1.3rem" /></button>
          )}
          <button type="button" className="dz-act danger" onClick={onRemove} title="Remove"><IconTrash size="1.3rem" /></button>
        </div>
      </div>
      {open && <div className="dz-block-body">{children}</div>}
    </div>
  );
}

/** First short text value of a block — what the collapsed header shows */
export function blockSummary(value: Record<string, unknown>): string | undefined {
  for (const [k, v] of Object.entries(value)) {
    if (k === "__component") continue;
    if (typeof v === "string" && v.trim()) return v.length > 60 ? `${v.slice(0, 60)}…` : v;
  }
  return undefined;
}
