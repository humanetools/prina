import { useEffect, useRef, useState } from "react";
import { IconPencil } from "@tabler/icons-react";

/**
 * Type / component name, editable in place (user, 2026-09-08; components 2026-11-11): hover shows a pencil, click swaps the
 * heading for an input; Enter/blur saves through the same PUT the definition uses, Esc
 * cancels. The uid never changes — only the display name.
 */
export function InlineName({ name, label, onSave }: { name: string; label: string; onSave(next: string): Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (!editing) setValue(name); }, [name, editing]);
  useEffect(() => { if (editing) { inputRef.current?.focus(); inputRef.current?.select(); } }, [editing]);
  const commit = async () => {
    const next = value.trim();
    if (!next || next === name) { setEditing(false); setValue(name); return; }
    setBusy(true);
    try { await onSave(next); setEditing(false); } finally { setBusy(false); }
  };
  if (editing) {
    return (
      <input
        ref={inputRef}
        className="type-h1 type-h1-input"
        value={value}
        aria-label={label}
        disabled={busy}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); void commit(); }
          if (e.key === "Escape") { setValue(name); setEditing(false); }
        }}
      />
    );
  }
  return (
    <span className="type-name">
      <h1 className="type-h1">{name}</h1>
      <button type="button" className="type-name-edit" title="Rename" aria-label={`Rename ${name}`} onClick={() => setEditing(true)}>
        <IconPencil size="1.6rem" />
      </button>
    </span>
  );
}
