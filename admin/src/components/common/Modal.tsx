import type { ReactNode } from "react";
import { IconX } from "@tabler/icons-react";

export function Modal({
  title,
  onClose,
  children,
  wide,
  headExtra,
}: {
  title: string;
  onClose(): void;
  children: ReactNode;
  wide?: boolean;
  /** Rendered in the head row between the title and the close button (right-aligned) */
  headExtra?: ReactNode;
}) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className={wide ? "modal modal-wide" : "modal"}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={title}
      >
        <div className="modal-head">
          <h3>{title}</h3>
          {headExtra && <div className="modal-head-extra">{headExtra}</div>}
          <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close">
            <IconX size="1.6rem" />
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}
