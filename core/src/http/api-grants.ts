/**
 * REST access-token grants (20-IMPL-access-token-scopes).
 *
 * A management token issued as an access token carries `grants` — area ▸ item ▸ read|edit,
 * optionally narrowed to content types. This module is the single source for:
 *  - which route needs which item/level (and, for content routes, which type)      → the hook
 *  - which permission rows a grant list amounts to                                    → RBAC
 * Everything not listed is closed to tokens by design (identity, setup, users/roles,
 * token issuance, AI keys, workspace settings, tunnel).
 */
import {
  ApiGrantItem,
  ApiGrantLevel,
  PermissionAction,
  SystemSubject,
  type ApiGrant,
} from "@prina/shared";

export interface GrantRequirement {
  item: ApiGrantItem;
  level: ApiGrantLevel;
  /** content routes: the type in the path, matched against a grant's `types` */
  typeUid?: string;
}

const pathOf = (url: string) => { const q = url.indexOf("?"); return q === -1 ? url : url.slice(0, q); };
const isRead = (m: string) => m === "GET" || m === "HEAD";

/** Which item + level a request needs; null = the path is closed to tokens */
export function requiredGrantFor(method: string, url: string): GrantRequirement | null {
  const path = pathOf(url);
  const m = method.toUpperCase();
  const rw = isRead(m) ? ApiGrantLevel.Read : ApiGrantLevel.Edit;

  // CTB — content types (+ presets, schema.org vocabulary lookups) and components
  if (/^\/api\/content-types(\/|$)/.test(path) || /^\/api\/presets(\/|$)/.test(path) || /^\/api\/schema-org(\/|$)/.test(path)) {
    return { item: ApiGrantItem.ContentTypes, level: rw };
  }
  if (/^\/api\/components(\/|$)/.test(path)) return { item: ApiGrantItem.Components, level: rw };

  // Content — entries per type; transition is its own item; draft preview links read entries
  const content = /^\/api\/content\/([^/]+)(\/[^/]+)?(\/[^/]+)?/.exec(path);
  if (content) {
    const typeUid = decodeURIComponent(content[1]!);
    if (path.endsWith("/transition")) return { item: ApiGrantItem.Publish, level: ApiGrantLevel.Edit, typeUid };
    return { item: ApiGrantItem.Entries, level: rw, typeUid };
  }
  if (path === "/api/delivery/draft-token") return { item: ApiGrantItem.Entries, level: ApiGrantLevel.Read };
  if (/^\/api\/import(\/|$)/.test(path)) return { item: ApiGrantItem.Import, level: ApiGrantLevel.Edit };

  if (/^\/api\/assets(\/|$)/.test(path)) return { item: ApiGrantItem.Assets, level: rw };
  if (/^\/api\/templates\//.test(path)) {
    // preview only renders — a read
    return { item: ApiGrantItem.Templates, level: path.endsWith("/preview") ? ApiGrantLevel.Read : rw };
  }
  if (/^\/api\/locales(\/|$)/.test(path)) return { item: ApiGrantItem.Locales, level: rw };
  if (/^\/api\/taxonomies(\/|$)/.test(path) || /^\/api\/taxonomy-nodes(\/|$)/.test(path)) return { item: ApiGrantItem.Taxonomies, level: rw };
  return null;
}

const RANK: Record<ApiGrantLevel, number> = { [ApiGrantLevel.Read]: 1, [ApiGrantLevel.Edit]: 2 };

/** The grant that satisfies the requirement, or null */
export function matchGrant(grants: ApiGrant[], req: GrantRequirement): ApiGrant | null {
  return (
    grants.find(
      (g) =>
        g.item === req.item &&
        RANK[g.level] >= RANK[req.level] &&
        (!req.typeUid || !g.types || g.types.includes(req.typeUid)),
    ) ?? null
  );
}

export interface GrantPermissionRow { action: string; subject: string; fields: null; locales: null }
const row = (action: string, subject: string): GrantPermissionRow => ({ action, subject, fields: null, locales: null });
const CRUD = [PermissionAction.Create, PermissionAction.Read, PermissionAction.Update, PermissionAction.Delete];

/** Concrete actions a grant confers (used both to build rows and to check the issuer's ceiling) */
export function actionsOf(g: ApiGrant): string[] {
  switch (g.item) {
    case ApiGrantItem.Publish: return [PermissionAction.Transition, PermissionAction.Publish];
    case ApiGrantItem.Import: return [PermissionAction.Create];
    default: return g.level === ApiGrantLevel.Read ? [PermissionAction.Read] : CRUD;
  }
}

/** Subjects a grant covers */
export function subjectsOf(g: ApiGrant): string[] {
  switch (g.item) {
    case ApiGrantItem.ContentTypes: return [SystemSubject.ContentTypeBuilder];
    case ApiGrantItem.Components: return [SystemSubject.Components];
    case ApiGrantItem.Entries:
    case ApiGrantItem.Publish:
    case ApiGrantItem.Import:
      return g.types && g.types.length > 0 ? g.types.map((t) => `content:${t}`) : ["content:*"];
    case ApiGrantItem.Assets: return [SystemSubject.Media];
    case ApiGrantItem.Templates:
      return g.level === ApiGrantLevel.Edit ? [SystemSubject.Templates, SystemSubject.TemplateScript] : [SystemSubject.Templates];
    case ApiGrantItem.Locales: return [SystemSubject.Locales];
    case ApiGrantItem.Taxonomies: return [SystemSubject.Taxonomy];
  }
}

/** Grants → permission rows the RBAC matcher understands — the token's whole right set */
export function permissionsFromGrants(grants: ApiGrant[]): GrantPermissionRow[] {
  const out: GrantPermissionRow[] = [];
  for (const g of grants) for (const subject of subjectsOf(g)) for (const action of actionsOf(g)) out.push(row(action, subject));
  return out;
}
