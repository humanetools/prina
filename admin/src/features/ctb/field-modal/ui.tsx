/** Shared bits for the field modals — toggle switch, info box */

export function Switch({
  on,
  label,
  desc,
  onToggle,
}: {
  on: boolean;
  label: string;
  desc?: string;
  onToggle(): void;
}) {
  return (
    <div className="switch-row">
      <span className="switch-row-text">
        <span className="switch-row-label">{label}</span>
        {desc && <span className="switch-row-desc">{desc}</span>}
      </span>
      <button
        type="button"
        className={on ? "switch on" : "switch"}
        role="switch"
        aria-checked={on}
        aria-label={label}
        onClick={onToggle}
      >
        <span className="switch-knob" />
      </button>
    </div>
  );
}

export function ReviewNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="fm-note">
      <span className="fm-note-dot">!</span>
      <span className="fm-note-text">{children}</span>
    </div>
  );
}
