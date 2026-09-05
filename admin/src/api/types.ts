/**
 * API types/enums — kept in sync with prina-core `@prina/shared` (global rule: sync enums on both sides).
 * The shared package lives inside the core repo, so this file is admin's corresponding copy.
 */

export enum EntryStatus {
  Draft = "draft",
  Review = "review",
  Approved = "approved",
  Published = "published",
}

export enum ActorType {
  Human = "human",
  Ai = "ai",
  System = "system",
}

export enum ContentTypeKind {
  Collection = "collection",
  Single = "single",
}

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

export const SystemSubjects = {
  ContentTypeBuilder: "system:ctb",
  Components: "system:components",
  Media: "system:media",
  Taxonomy: "system:taxonomy",
  Templates: "system:templates",
  TemplateScript: "system:template_script",
  Workflows: "system:workflows",
  Locales: "system:locales",
  UsersRoles: "system:users",
  Settings: "system:settings",
  McpConsole: "system:mcp",
} as const;

export interface FieldDef {
  name: string;
  type: FieldType;
  label?: string;
  description?: string;
  required?: boolean;
  localized?: boolean;
  completenessWeight?: number;
  // Per-type options (validated by the server defSchema)
  [key: string]: unknown;
}

export interface ContentTypeDefinition {
  fields: FieldDef[];
  displayField?: string;
  /** Edition namespace (opaque to core) — EE features keep per-type flags here, e.g. ee.chatbot.excluded */
  ee?: Record<string, unknown>;
}

/** Per-entry SEO record (mirror of @prina/shared EntrySeo) */
export interface EntrySeo {
  metaTitle?: string;
  metaDescription?: string;
  canonical?: string;
  ogImage?: string;
  ogTitle?: string;
  ogDescription?: string;
  noindex?: boolean;
}

/** Per-type SEO configuration (content_types.options.seo — mirror of @prina/shared) */
export interface SeoTypeOptions {
  enabled: boolean;
  urlPattern?: string;
  /** Absolute pattern to an external original (syndicated collections) — becomes the canonical */
  externalCanonicalPattern?: string;
  strictPublish?: boolean;
  sitemap?: { include: boolean; priority?: number; changefreq?: string };
}

/** Workspace-global SEO settings (workspaces.settings.seo — mirror of @prina/shared) */
export interface WorkspaceSeoSettings {
  siteBaseUrl?: string;
  titleSuffix?: string;
  defaultOgImage?: string;
  robots?: { extraDisallow?: string[] };
}

/** Preview audit finding (mirror of @prina/shared AuditFinding) — "manual" = verify by hand */
export interface AuditFinding {
  rule: string;
  severity: "error" | "warn" | "manual";
  message: string;
  selectorPath?: string;
  snippet?: string;
}

/** Publish-readiness advisory (mirror of @prina/shared PublishAdvisory) */
export interface PublishAdvisory {
  code: string;
  severity: "error" | "warn";
  field?: string;
  message: string;
}

export interface ContentType {
  id: string;
  uid: string;
  kind: ContentTypeKind;
  name: string;
  description: string | null;
  schemaOrgType: string | null;
  schemaOrgSecondary?: string | null;
  definition: ContentTypeDefinition;
  /** Per-type options — seo is the only known key today, unknown keys pass through */
  options?: { seo?: SeoTypeOptions; [key: string]: unknown };
  version: number;
  updatedAt: string;
  /** Entry count excluding variant children (nav count) */
  entryCount?: number;
}

export interface ComponentDef {
  id: string;
  uid: string;
  name: string;
  definition: ContentTypeDefinition;
  version: number;
}

/** AI-draft provenance (mirror of @prina/shared EntryAiDraft) — null once a human saves/transitions */
export interface EntryAiDraft {
  kind: "translation" | "assistant";
  sourceEntryId?: string;
  sourceLocale?: string;
  model: string;
  createdAt: string;
  fields: string[];
}

export interface Entry {
  id: string;
  documentId: string;
  locale: string;
  status: EntryStatus;
  values: Record<string, unknown>;
  aiDraft?: EntryAiDraft | null;
  variantValues: Record<string, string> | null;
  parentEntryId: string | null;
  completeness: { score: number } | null;
  seo?: EntrySeo | null;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  updatedBy: string | null;
}

export interface Completeness {
  score: number;
  missing: Array<{ field: string; label?: string; reason: string }>;
}

export interface EntryDetail {
  entry: Entry;
  effectiveValues: Record<string, unknown>;
  completeness: Completeness;
  advisories: PublishAdvisory[];
  variants: Array<{
    id: string;
    variantValues: Record<string, string> | null;
    status: EntryStatus;
    values: Record<string, unknown>;
  }>;
  overriddenFields: string[] | null;
  taxonomies: Array<{
    nodeId: string;
    attributeValues: Record<string, unknown> | null;
    name: string;
    path: string;
    attributeComponentUid: string | null;
  }>;
}

export interface Paginated<T> {
  items: T[];
  pagination: { page: number; pageSize: number; total: number; pageCount?: number };
}

export interface VersionRow {
  id: string;
  version: number;
  snapshot: { values: Record<string, unknown>; status: string; locale: string };
  diff: Record<string, { before: unknown; after: unknown }> | null;
  actorType: ActorType;
  actorId: string | null;
  createdAt: string;
}

export interface AuditRow {
  id: number;
  actorType: ActorType;
  actorId: string | null;
  actorLabel: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

export interface Role {
  id: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  permissions: PermissionRow[];
}

export interface PermissionRow {
  id: string;
  roleId: string;
  action: string;
  subject: string;
  fields: string[] | null;
  locales: string[] | null;
}

export interface UserRow {
  id: string;
  username: string;
  name: string;
  isInstanceAdmin: boolean;
  isActive: boolean;
  roleIds: string[];
}

export interface Locale {
  id: string;
  code: string;
  name: string;
  isDefault: boolean;
  /** Entries using this locale — the server refuses deletion while non-zero */
  entryCount: number;
}

export interface Workflow {
  id: string;
  name: string;
  states: string[];
  transitions: Array<{
    id: string;
    fromState: string;
    toState: string;
    allowedRoleIds: string[] | null;
  }>;
}

export interface TaxonomyRow {
  id: string;
  uid: string;
  name: string;
  description: string | null;
}

export interface TaxonomyNode {
  id: string;
  taxonomyId: string;
  parentId: string | null;
  name: string;
  slug: string;
  path: string;
  attributeComponentUid: string | null;
  position: number;
}

export interface Workspace {
  id: string;
  slug: string;
  name: string;
}

/** Mirror of core modules/asset/analysis.ts (§0.11 4b) — lives in Asset.metadata.analysis */
export interface RegionStat {
  luminance: number;
  whiteContrast: number;
  blackContrast: number;
}
export interface AssetAnalysis {
  version: 1;
  dominant: string;
  overall: RegionStat;
  top: RegionStat;
  middle: RegionStat;
  bottom: RegionStat;
}

export interface Asset {
  id: string;
  folder: string;
  filename: string;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  /** a11y (WCAG 1.1.1) — null = not described yet, "" = decorative */
  alt: string | null;
  metadata: Record<string, unknown>;
  status: string;
  createdAt: string;
  usageCount?: number;
  renditions: Record<string, string> | null;
  downloadUrl: string;
}

export interface AssetDetail extends Asset {
  usages: Array<{
    entryId: string;
    field: string;
    typeUid: string;
    typeName: string;
    entryValues: Record<string, unknown>;
    locale: string;
  }>;
  deletable: boolean;
}

export interface UploadTicket {
  asset: Asset;
  upload: { url: string; method: "PUT"; headers?: Record<string, string> };
}

/** Per-market GA4 settings (workspaces.settings.ga4Markets) — mirror of core delivery/ga4.ts */
export interface Ga4Market {
  currency: string;
  containerId?: string;
}

export interface Ga4Config {
  currency?: string;
  /** Legacy fallback for events without their own mapping (pre-2026-08-22 configs) */
  itemMapping: Record<string, string>;
  valueField?: string;
  events: Array<{
    event: string;
    params: Record<string, string>;
    /** Per-event items mapping — GA4 lets each event carry its own items shape */
    itemMapping?: Record<string, string>;
    valueField?: string;
  }>;
}

export interface TemplateRow {
  id: string;
  version: number;
  liquid: string;
  css: string;
  js: string;
  events: Ga4Config | Record<string, never>;
  isCurrent: boolean;
  createdAt: string;
}

export interface TemplateGetResult {
  current: TemplateRow | null;
  versions: Array<{ id: string; version: number; isCurrent: boolean; createdAt: string }>;
  canEditScript: boolean;
}

export interface McpToken {
  id: string;
  plane: "management" | "delivery";
  name: string;
  roleId: string | null;
  localeScope: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Public address (IMPL-public-tunnel) — GET /api/tunnel/status */
export interface TunnelStatus {
  configured: boolean;
  enabled: boolean;
  host: string | null;
  expiresAt: number | null;
  running: boolean;
  cloudflaredAvailable: boolean;
  lastError: string | null;
  /** Whether /admin·/api are open on the public address (Cloudflare Access guards the front) */
  remoteAdmin: boolean;
  /** Only addresses with an ownership token can toggle this (older issues need re-provisioning) */
  canToggleRemoteAdmin: boolean;
}

/** GA4 catalog — in sync with server delivery/ga4.ts (full official ecommerce/list/promotion/lead sets) */
export const GA4_EVENTS: Array<{ name: string; group: string; trigger: string }> = [
  { name: "view_item", group: "E-commerce", trigger: "view" },
  { name: "add_to_cart", group: "E-commerce", trigger: "click" },
  { name: "remove_from_cart", group: "E-commerce", trigger: "click" },
  { name: "view_cart", group: "E-commerce", trigger: "click" },
  { name: "add_to_wishlist", group: "E-commerce", trigger: "click" },
  { name: "begin_checkout", group: "E-commerce", trigger: "click" },
  { name: "add_shipping_info", group: "E-commerce", trigger: "click" },
  { name: "add_payment_info", group: "E-commerce", trigger: "click" },
  { name: "purchase", group: "E-commerce", trigger: "click" },
  { name: "refund", group: "E-commerce", trigger: "click" },
  { name: "view_item_list", group: "List", trigger: "view" },
  { name: "select_item", group: "List", trigger: "click" },
  { name: "view_promotion", group: "Promotion", trigger: "view" },
  { name: "select_promotion", group: "Promotion", trigger: "click" },
  { name: "generate_lead", group: "Lead", trigger: "click" },
  { name: "qualify_lead", group: "Lead", trigger: "click" },
  { name: "disqualify_lead", group: "Lead", trigger: "click" },
  { name: "working_lead", group: "Lead", trigger: "click" },
  { name: "close_convert_lead", group: "Lead", trigger: "click" },
  { name: "close_unconvert_lead", group: "Lead", trigger: "click" },
];
/**
 * Event-level parameters per GA4 event (official GTM ecommerce spec).
 * These live in `events[].params` and are emitted INSIDE the ecommerce object
 * (lead events emit them at top level). Item-array params are shared — GA4_ITEM_PARAMS.
 */
export const GA4_EVENT_PARAMS: Record<string, Array<{ name: string; required?: boolean }>> = {
  view_item: [], add_to_cart: [], remove_from_cart: [], view_cart: [], add_to_wishlist: [],
  begin_checkout: [{ name: "coupon" }],
  add_shipping_info: [{ name: "coupon" }, { name: "shipping_tier" }],
  add_payment_info: [{ name: "coupon" }, { name: "payment_type" }],
  purchase: [{ name: "transaction_id", required: true }, { name: "tax" }, { name: "shipping" }, { name: "coupon" }],
  refund: [{ name: "transaction_id", required: true }, { name: "tax" }, { name: "shipping" }, { name: "coupon" }],
  view_item_list: [{ name: "item_list_id" }, { name: "item_list_name" }],
  select_item: [{ name: "item_list_id" }, { name: "item_list_name" }],
  view_promotion: [{ name: "promotion_id" }, { name: "promotion_name" }, { name: "creative_name" }, { name: "creative_slot" }],
  select_promotion: [{ name: "promotion_id" }, { name: "promotion_name" }, { name: "creative_name" }, { name: "creative_slot" }],
  generate_lead: [{ name: "lead_source" }],
  qualify_lead: [], disqualify_lead: [], working_lead: [], close_convert_lead: [], close_unconvert_lead: [],
};

/** Official items-array parameter set (creative_name/slot are event-level only — via event params) */
export const GA4_ITEM_PARAMS = [
  "item_id",
  "item_name",
  "item_brand",
  "item_variant",
  "item_category",
  "item_category2",
  "item_category3",
  "item_category4",
  "item_category5",
  "price",
  "quantity",
  "discount",
  "coupon",
  "affiliation",
  "index",
  "item_list_id",
  "item_list_name",
  "location_id",
  "promotion_id",
  "promotion_name",
  "google_business_vertical",
];

export interface Me {
  user: { id: string; username: string; name: string; isInstanceAdmin: boolean };
  memberships: Array<{ workspaceId: string; roleId: string }>;
}

export interface SetupState {
  adminCreated: boolean;
  workspaceConfigured: boolean;
  localesConfigured: boolean;
  completed: boolean;
}

/** License state (T8.2/T8.3) — copy of core modules/license/service.ts LicenseState */
export interface LicenseState {
  status: "unlicensed" | "valid" | "expired" | "revoked" | "invalid" | "grace" | "grace_expired";
  reason: string | null;
  customer: string | null;
  plan: string | null;
  expiresAt: number | null;
  lastCheckedAt: number | null;
  lastServerOkAt: number | null;
  source: "offline" | "server";
  latestPatch: string | null;
  latestCritical: boolean;
  updateAvailable: boolean;
}
