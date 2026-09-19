/**
 * Single source of truth for status/category enums.
 * Backend (DB pgEnum), Admin, and MCP all consume these definitions — no raw string comparisons.
 */

/** Entry workflow status (SPEC §2.3 default preset) */
export enum EntryStatus {
  Draft = "draft",
  Review = "review",
  Approved = "approved",
  Published = "published",
}

/** Audit log actor type (SPEC §2.2 — the human/AI distinction is a product differentiator) */
export enum ActorType {
  Human = "human",
  Ai = "ai",
  System = "system",
}

/** Content type kind (keeps Strapi's conventional terminology) */
export enum ContentTypeKind {
  Collection = "collection",
  Single = "single",
}

/** Field type registry keys (SPEC §2.1, T1.2) */
export enum FieldType {
  Text = "text",
  Uid = "uid",
  Richtext = "richtext",
  Number = "number",
  Boolean = "boolean",
  Date = "date",
  Enum = "enum",
  Json = "json",
  Media = "media",
  Relation = "relation",
  Component = "component",
  DynamicZone = "dynamic_zone",
  VariantAxis = "variant_axis",
}

/** Permission actions (type x CRUD; field/locale dimensions are combined in T2.2) */
export enum PermissionAction {
  Create = "create",
  Read = "read",
  Update = "update",
  Delete = "delete",
  Transition = "transition",
  Publish = "publish",
}

/** Asset storage status */
export enum AssetStatus {
  Uploading = "uploading",
  Ready = "ready",
}

/** MCP planes (§2.6): management vs delivery */
export enum McpPlane {
  Management = "management",
  Delivery = "delivery",
}

/**
 * REST access-token scopes (20-IMPL-access-token-scopes): a management token reaches only the
 * resource groups it was issued for, at read or edit level. Permissions inside a group still come
 * from the token's role — the scope is the surface, the role is the right.
 */
export enum ApiScope {
  /** /api/content/*, /api/import/* */
  Content = "content",
  /** /api/content-types/*, /api/components/*, /api/presets/*, /api/schema-org/* */
  Schema = "schema",
  /** /api/assets/* */
  Assets = "assets",
  /** /api/locales/* */
  Locales = "locales",
  /** /api/templates/* */
  Templates = "templates",
  /** /api/taxonomies/*, /api/taxonomy-nodes/* */
  Taxonomies = "taxonomies",
}
export enum ApiScopeLevel {
  Read = "read",
  Edit = "edit",
}
/** Granted scopes — a missing key means no access to that group */
export type ApiScopes = Partial<Record<ApiScope, ApiScopeLevel>>;
/** Tokens issued before scopes existed carry NULL and behave as before: content, edit */
export const LEGACY_API_SCOPES: ApiScopes = { [ApiScope.Content]: ApiScopeLevel.Edit };
export const API_SCOPES = Object.values(ApiScope);

/**
 * REST access-token grants (20-IMPL, custom mode). Alongside role-based tokens (role + resource
 * scopes above), a token can instead carry explicit grants: area ▸ item ▸ read|edit, optionally
 * narrowed to content types. The grant list is both the surface and the right set — no role.
 */
export enum ApiGrantArea {
  Ctb = "ctb",
  Content = "content",
  Media = "media",
  Templates = "templates",
  Locales = "locales",
  Taxonomies = "taxonomies",
}
export enum ApiGrantItem {
  /** /api/content-types, /api/presets, /api/schema-org (the builder incl. predicate/SEO options) */
  ContentTypes = "content_types",
  /** /api/components */
  Components = "components",
  /** /api/content/:type (+ draft preview links) — narrowable by type */
  Entries = "entries",
  /** /api/content/:type/:id/transition — edit only, narrowable by type */
  Publish = "publish",
  /** /api/import/* — edit only, narrowable by type */
  Import = "import",
  /** /api/assets */
  Assets = "assets",
  /** /api/templates (edit includes script.js) */
  Templates = "templates",
  /** /api/locales */
  Locales = "locales",
  /** /api/taxonomies, /api/taxonomy-nodes */
  Taxonomies = "taxonomies",
}
export enum ApiGrantLevel {
  Read = "read",
  Edit = "edit",
}
export interface ApiGrant {
  item: ApiGrantItem;
  level: ApiGrantLevel;
  /** Entries / Publish / Import only — content type uids; omitted = all types */
  types?: string[];
}
export const API_GRANT_AREA_OF: Record<ApiGrantItem, ApiGrantArea> = {
  [ApiGrantItem.ContentTypes]: ApiGrantArea.Ctb,
  [ApiGrantItem.Components]: ApiGrantArea.Ctb,
  [ApiGrantItem.Entries]: ApiGrantArea.Content,
  [ApiGrantItem.Publish]: ApiGrantArea.Content,
  [ApiGrantItem.Import]: ApiGrantArea.Content,
  [ApiGrantItem.Assets]: ApiGrantArea.Media,
  [ApiGrantItem.Templates]: ApiGrantArea.Templates,
  [ApiGrantItem.Locales]: ApiGrantArea.Locales,
  [ApiGrantItem.Taxonomies]: ApiGrantArea.Taxonomies,
};
/** Items that only make sense as edit */
export const API_GRANT_EDIT_ONLY: ReadonlyArray<ApiGrantItem> = [ApiGrantItem.Publish, ApiGrantItem.Import];
/** Items that accept a content-type restriction */
export const API_GRANT_TYPED: ReadonlyArray<ApiGrantItem> = [ApiGrantItem.Entries, ApiGrantItem.Publish, ApiGrantItem.Import];
export const API_GRANT_ITEMS = Object.values(ApiGrantItem);

export const ENTRY_STATUSES = Object.values(EntryStatus);
export const ACTOR_TYPES = Object.values(ActorType);
export const CONTENT_TYPE_KINDS = Object.values(ContentTypeKind);
export const FIELD_TYPES = Object.values(FieldType);
