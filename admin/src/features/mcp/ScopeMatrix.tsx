/** Access-token scope matrix (20-IMPL) — one row per resource group, None / Read / Edit, Cloudflare-style */
import { ApiScope, ApiScopeLevel, type ApiScopes, type Role } from "../../api/types";

export const SCOPE_ROWS: ReadonlyArray<{ scope: ApiScope; label: string; paths: string }> = [
  { scope: ApiScope.Content, label: "Content", paths: "/api/content · /api/import — entries, transitions, SEO, CSV import" },
  { scope: ApiScope.Schema, label: "Schema", paths: "/api/content-types · /api/components · presets · schema.org — the Content-type Builder" },
  { scope: ApiScope.Assets, label: "Assets", paths: "/api/assets — presigned uploads, alt text, delete" },
  { scope: ApiScope.Locales, label: "Locales", paths: "/api/locales" },
  { scope: ApiScope.Templates, label: "Templates", paths: "/api/templates — save, activate versions, preview" },
  { scope: ApiScope.Taxonomies, label: "Taxonomies", paths: "/api/taxonomies · /api/taxonomy-nodes" },
];

/** Permission subjects that back each group — the role's rights here cap what a token can be granted */
const SCOPE_SUBJECTS: Record<ApiScope, ReadonlyArray<string>> = {
  [ApiScope.Content]: ["content:"],
  [ApiScope.Schema]: ["system:ctb", "system:components"],
  [ApiScope.Assets]: ["system:media"],
  [ApiScope.Locales]: ["system:locales"],
  [ApiScope.Templates]: ["system:templates", "system:template_script"],
  [ApiScope.Taxonomies]: ["system:taxonomy"],
};
const RANK: Record<ApiScopeLevel, number> = { [ApiScopeLevel.Read]: 1, [ApiScopeLevel.Edit]: 2 };

/** Highest level the role could exercise per group: edit if it may write there, read if it may only read, null if nothing */
export type ScopeCeiling = Partial<Record<ApiScope, ApiScopeLevel | null>>;
export function roleScopeCeiling(role: Role | undefined): ScopeCeiling | undefined {
  if (!role) return undefined;
  const out: ScopeCeiling = {};
  for (const row of SCOPE_ROWS) {
    let level: ApiScopeLevel | null = null;
    for (const p of role.permissions) {
      const hits = p.subject === "*" || SCOPE_SUBJECTS[row.scope].some((s) => (s.endsWith(":") ? p.subject.startsWith(s) : p.subject === s));
      if (!hits) continue;
      if (p.action === "read") level = level ?? ApiScopeLevel.Read;
      else { level = ApiScopeLevel.Edit; break; }
    }
    out[row.scope] = level;
  }
  return out;
}

/** Drop grants the role cannot back (used when the role changes) */
export function clampScopes(scopes: ApiScopes, ceiling: ScopeCeiling | undefined): ApiScopes {
  if (!ceiling) return scopes;
  const next: ApiScopes = {};
  for (const [scope, level] of Object.entries(scopes) as Array<[ApiScope, ApiScopeLevel]>) {
    const max = ceiling[scope] ?? null;
    if (max === null) continue;
    next[scope] = RANK[level] > RANK[max] ? max : level;
  }
  return next;
}

const LEVELS: ReadonlyArray<{ value: ApiScopeLevel | null; label: string }> = [
  { value: null, label: "None" },
  { value: ApiScopeLevel.Read, label: "Read" },
  { value: ApiScopeLevel.Edit, label: "Edit" },
];

export function ScopeMatrix({
  value,
  onChange,
  ceiling,
  roleName,
}: {
  value: ApiScopes;
  onChange(next: ApiScopes): void;
  /** From roleScopeCeiling — levels the role cannot back are disabled */
  ceiling?: ScopeCeiling;
  roleName?: string;
}) {
  const set = (scope: ApiScope, level: ApiScopeLevel | null) => {
    const next = { ...value };
    if (level === null) delete next[scope];
    else next[scope] = level;
    onChange(next);
  };
  return (
    <div className="scope-matrix" role="group" aria-label="API access">
      {SCOPE_ROWS.map((row) => {
        const max = ceiling ? (ceiling[row.scope] ?? null) : undefined;
        const blocked = (l: ApiScopeLevel | null) => l !== null && max !== undefined && (max === null || RANK[l] > RANK[max]);
        return (
          <div key={row.scope} className={max === null ? "scope-row off" : "scope-row"}>
            <div className="scope-row-text">
              <b>{row.label}</b>
              <span>{row.paths}</span>
              {max === null && <em className="scope-row-note">{roleName ?? "This role"} has no permission here</em>}
              {max === ApiScopeLevel.Read && <em className="scope-row-note">{roleName ?? "This role"} can only read here</em>}
            </div>
            <div className="seg scope-seg">
              {LEVELS.map((l) => (
                <button
                  key={l.label}
                  type="button"
                  className={(value[row.scope] ?? null) === l.value ? "active" : ""}
                  aria-pressed={(value[row.scope] ?? null) === l.value}
                  disabled={blocked(l.value)}
                  title={blocked(l.value) ? `The bound role cannot ${l.label.toLowerCase()} here — grant it on the role first` : undefined}
                  onClick={() => set(row.scope, l.value)}
                >
                  {l.label}
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** "edit content · read schema" — for the modal summary and the token card */
export function describeScopes(scopes: ApiScopes | null | undefined): string {
  if (!scopes) return "—";
  const parts = SCOPE_ROWS.filter((r) => scopes[r.scope]).map((r) => `${scopes[r.scope]} ${r.label.toLowerCase()}`);
  return parts.length ? parts.join(" · ") : "no API access";
}

export function ScopeChips({ scopes }: { scopes: ApiScopes | null | undefined }) {
  if (!scopes) return <span>—</span>;
  const rows = SCOPE_ROWS.filter((r) => scopes[r.scope]);
  if (rows.length === 0) return <span>no API access</span>;
  return (
    <span className="scope-chips">
      {rows.map((r) => (
        <span key={r.scope} className={`scope-chip ${scopes[r.scope]}`} title={r.paths}>
          {r.label.toLowerCase()} · {scopes[r.scope]}
        </span>
      ))}
    </span>
  );
}
