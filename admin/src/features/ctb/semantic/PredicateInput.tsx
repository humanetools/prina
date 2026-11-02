/** predicate input + schema.org property autocomplete — nudges toward the standard term over a custom one */
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";

export function PredicateInput({
  value,
  onChange,
}: {
  value: string;
  onChange(v: string | undefined): void;
}) {
  const [query, setQuery] = useState(value);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => setQuery(value), [value]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const { data } = useQuery({
    queryKey: ["schema-org-properties"],
    queryFn: () =>
      api<{ properties: Array<{ name: string; domains: string[] }> }>("/api/schema-org/properties"),
    staleTime: 60 * 60 * 1000,
  });
  const all = data?.properties ?? [];

  const q = query.trim().toLowerCase();
  const matches = q
    ? all
        .filter((p) => p.name.toLowerCase().includes(q))
        .sort((a, b) => {
          const ap = a.name.toLowerCase().startsWith(q) ? 0 : 1;
          const bp = b.name.toLowerCase().startsWith(q) ? 0 : 1;
          return ap - bp || a.name.localeCompare(b.name);
        })
        .slice(0, 8)
    : [];
  const isStandard = all.some((p) => p.name === query.trim());
  const isNamespaced = query.includes(":");

  const commit = (v: string) => {
    setQuery(v);
    onChange(v || undefined);
    setOpen(false);
  };

  return (
    <div className="sem-combo" ref={rootRef}>
      <input
        className="mono" value={query} placeholder="isRelatedTo / gs1:… / custom_name"
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => onChange(query.trim() || undefined)}
        onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }}
      />
      {query.trim() && (
        <p className="widget-hint" style={isStandard ? { color: "var(--published)" } : undefined}>
          {isStandard
            ? "✓ schema.org standard property"
            : isNamespaced
              ? "External vocabulary — emitted as-is"
              : "Custom predicate — kept via @context (fine for the internal graph)"}
        </p>
      )}
      {open && matches.length > 0 && (
        <div className="sem-pop">
          <div className="sem-pop-list">
            {matches.map((p) => (
              <button
                key={p.name} type="button" className="sem-opt"
                onMouseDown={(e) => { e.preventDefault(); commit(p.name); }}
              >
                <span className="sem-opt-label">{p.name}</span>
                <span className="sem-opt-note">of {p.domains.slice(0, 2).join(", ")}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
