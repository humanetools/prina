/** schema.org type search combobox (design Primary/Secondary type) — searches all 933 classes */
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { IconSearch } from "@tabler/icons-react";
import { api } from "../../../api/client";
import { SCHEMA_ORG_TYPES } from "./schema-org";

const CURATED_NOTE = new Map(SCHEMA_ORG_TYPES);

export function SchemaCombobox({
  label,
  value,
  allowNone,
  onPick,
}: {
  label: string;
  value: string | null;
  /** When true, offers a "None" option (for secondary) */
  allowNone?: boolean;
  onPick(value: string | null): void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const { data: vocabTypes } = useQuery({
    queryKey: ["schema-org-types"],
    queryFn: () => api<{ types: Array<{ name: string; parents: string[] }> }>("/api/schema-org/types"),
    staleTime: 60 * 60 * 1000,
  });
  const all = vocabTypes?.types ?? [];

  const q = query.trim().toLowerCase();
  // No query: curated list; with a query: search all 933 classes (prefix matches first)
  const options: Array<[string, string]> = !q
    ? SCHEMA_ORG_TYPES
    : all
        .filter((t) => t.name.toLowerCase().includes(q))
        .sort((a, b) => {
          const ap = a.name.toLowerCase().startsWith(q) ? 0 : 1;
          const bp = b.name.toLowerCase().startsWith(q) ? 0 : 1;
          return ap - bp || a.name.localeCompare(b.name);
        })
        .slice(0, 50)
        .map((t) => [
          t.name,
          CURATED_NOTE.get(t.name) ?? (t.parents[0] ? `subclass of ${t.parents[0]}` : ""),
        ]);
  const exact = all.some((t) => t.name.toLowerCase() === q);
  const custom = q && !exact ? query.trim() : null;

  const pick = (v: string | null) => {
    onPick(v);
    setOpen(false);
    setQuery("");
  };

  return (
    <div className="sem-combo" ref={rootRef}>
      <span className="sem-combo-label">{label}</span>
      {!open ? (
        <button type="button" className="sem-trigger" onClick={() => setOpen(true)}>
          <span className={value ? "sem-trigger-value" : "sem-trigger-value empty"}>
            {value ? `schema:${value}` : "None"}
          </span>
          <svg width="1.2rem" height="1.2rem" viewBox="0 0 12 12" fill="none" stroke="var(--text-3)" strokeWidth="1.6">
            <path d="M3 4.6 6 7.6 9 4.6" />
          </svg>
        </button>
      ) : (
        <div className="sem-trigger open">
          <IconSearch size="1.3rem" style={{ flex: "none", color: "var(--text-3)" }} />
          <input
            ref={inputRef} value={query} placeholder={value ? `schema:${value}` : "Search schema.org…"}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }}
          />
        </div>
      )}
      {open && (
        <div className="sem-pop">
          <div className="sem-pop-list">
            {allowNone && (
              <button type="button" className="sem-opt" onClick={() => pick(null)}>
                <span className="sem-opt-label" style={{ color: "var(--text-3)" }}>None</span>
              </button>
            )}
            {options.map(([t, note]) => (
              <button
                key={t} type="button"
                className={t === value ? "sem-opt on" : "sem-opt"}
                onClick={() => pick(t)}
              >
                <span className="sem-opt-label">schema:{t}</span>
                <span className="sem-opt-note">{note}</span>
              </button>
            ))}
            {custom && (
              <button type="button" className="sem-opt" onClick={() => pick(custom)}>
                <span className="sem-opt-label">schema:{custom}</span>
                <span className="sem-opt-note">use custom type</span>
              </button>
            )}
            {options.length === 0 && !custom && (
              <div className="sem-empty">No schema.org type matches that.</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
