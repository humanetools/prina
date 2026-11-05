/** Field delete confirmation (design DELETE FIELD CONFIRM) */
import { IconTrash } from "@tabler/icons-react";

export function DeleteFieldModal({
  fieldName,
  onConfirm,
  onCancel,
}: {
  fieldName: string;
  onConfirm(): void;
  onCancel(): void;
}) {
  return (
    <div className="fm-backdrop" onClick={onCancel}>
      <div className="fm-confirm" onClick={(e) => e.stopPropagation()} role="alertdialog" aria-label={`Delete ${fieldName}`}>
        <div className="fm-confirm-head">
          <span className="fm-confirm-icon"><IconTrash size="1.5rem" /></span>
          <div className="fm-confirm-title">Delete {fieldName}?</div>
        </div>
        <div className="fm-confirm-body">
          This removes the field from the schema and hides its stored values on
          <strong> all entries</strong>, in every locale. Templates referencing it will
          render empty until updated.
        </div>
        <div className="fm-confirm-note">
          Stored values stay in past versions — restoring a version brings them back.
        </div>
        <div className="fm-confirm-foot">
          <button className="btn" onClick={onCancel}>Cancel</button>
          <button className="btn-danger-solid" onClick={onConfirm}>Delete field</button>
        </div>
      </div>
    </div>
  );
}
