/**
 * REST access-token scopes (20-IMPL-access-token-scopes).
 *
 * A management token (pmt_mgmt_*) reaches `/api/*` only inside the resource groups it was issued
 * for, at the granted level. This table is the single place that says which path belongs to which
 * group and which requests count as reads. Everything not listed is closed to tokens — identity,
 * setup, users/roles, token issuance, AI keys, workspace settings — by design (default deny).
 *
 * The scope is the surface; the token's role is the right. Both must allow a request.
 */
import { ApiScope, ApiScopeLevel, type ApiScopes } from "@prina/shared";

/** Path prefix → scope. Order matters only for overlapping prefixes (none today). */
const SCOPE_PREFIXES: ReadonlyArray<readonly [string, ApiScope]> = [
  ["/api/content/", ApiScope.Content],
  ["/api/import/", ApiScope.Content],
  ["/api/content-types", ApiScope.Schema],
  ["/api/components", ApiScope.Schema],
  ["/api/presets", ApiScope.Schema],
  ["/api/schema-org", ApiScope.Schema],
  ["/api/assets", ApiScope.Assets],
  ["/api/locales", ApiScope.Locales],
  ["/api/templates/", ApiScope.Templates],
  ["/api/taxonomies", ApiScope.Taxonomies],
  ["/api/taxonomy-nodes", ApiScope.Taxonomies],
];

/**
 * POST routes that only read (the body is a query or a document to render, nothing is stored).
 * Matched on the path with `:param` segments replaced by `*`.
 */
const READ_POST_PATTERNS: ReadonlyArray<RegExp> = [
  /^\/api\/templates\/[^/]+\/preview$/,
  /^\/api\/import\/parse$/,
  /^\/api\/import\/validate$/,
  /^\/api\/content\/[^/]+\/[^/]+\/traverse$/,
];

export interface RequiredScope {
  scope: ApiScope;
  level: ApiScopeLevel;
}

const pathOf = (url: string): string => {
  const q = url.indexOf("?");
  return q === -1 ? url : url.slice(0, q);
};

/** Which scope + level a request needs; null = the path is closed to tokens */
export function requiredScopeFor(method: string, url: string): RequiredScope | null {
  const path = pathOf(url);
  const hit = SCOPE_PREFIXES.find(([prefix]) => path === prefix.replace(/\/$/, "") || path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`) || path === prefix);
  if (!hit) return null;
  const m = method.toUpperCase();
  const read = m === "GET" || m === "HEAD" || (m === "POST" && READ_POST_PATTERNS.some((re) => re.test(path)));
  return { scope: hit[1], level: read ? ApiScopeLevel.Read : ApiScopeLevel.Edit };
}

const RANK: Record<ApiScopeLevel, number> = { [ApiScopeLevel.Read]: 1, [ApiScopeLevel.Edit]: 2 };

/** Does the granted scope set cover the requirement? */
export function scopeAllows(granted: ApiScopes, required: RequiredScope): boolean {
  const level = granted[required.scope];
  return level !== undefined && RANK[level] >= RANK[required.level];
}

/** For OpenAPI (`x-prina-scope`) and tests — the same answer as the hook */
export const API_SCOPE_PREFIXES = SCOPE_PREFIXES;
