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

export const ENTRY_STATUSES = Object.values(EntryStatus);
export const ACTOR_TYPES = Object.values(ActorType);
export const CONTENT_TYPE_KINDS = Object.values(ContentTypeKind);
export const FIELD_TYPES = Object.values(FieldType);
