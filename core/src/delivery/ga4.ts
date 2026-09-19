/**
 * GA4 dataLayer config, validation, payloads (T5.4, §2.4 confirmed decisions — handle carefully)
 * - Standard events only (no custom namespaces)
 * - Reject save when required params are unmapped: purchase→transaction_id, ecommerce→currency+value
 * - currency comes from the workspace-wide default (settings.currency) or the event config
 */
import { z } from "zod";
import { ValidationError } from "../lib/errors.js";

/**
 * GA4 recommended event catalog — the full official ecommerce/list/promotion/lead sets
 * (developers.google.com/analytics/devguides/collection/ga4/ecommerce, 2026-08 spec).
 * Groups drive validation and payload shape:
 * - ecommerce: currency+value+items required (purchase/refund also transaction_id)
 * - list:      items required, no value (view_item_list/select_item carry item_list_* params)
 * - promotion: items + promotion_id or promotion_name required
 * - lead:      the lead-generation funnel; currency/value optional, params at top level
 */
export const GA4_CATALOG = {
  view_item: { group: "ecommerce", trigger: "view" },
  add_to_cart: { group: "ecommerce", trigger: "click" },
  remove_from_cart: { group: "ecommerce", trigger: "click" },
  view_cart: { group: "ecommerce", trigger: "click" },
  add_to_wishlist: { group: "ecommerce", trigger: "click" },
  begin_checkout: { group: "ecommerce", trigger: "click" },
  add_shipping_info: { group: "ecommerce", trigger: "click" },
  add_payment_info: { group: "ecommerce", trigger: "click" },
  purchase: { group: "ecommerce", trigger: "click" },
  refund: { group: "ecommerce", trigger: "click" },
  view_item_list: { group: "list", trigger: "view" },
  select_item: { group: "list", trigger: "click" },
  view_promotion: { group: "promotion", trigger: "view" },
  select_promotion: { group: "promotion", trigger: "click" },
  generate_lead: { group: "lead", trigger: "click" },
  qualify_lead: { group: "lead", trigger: "click" },
  disqualify_lead: { group: "lead", trigger: "click" },
  working_lead: { group: "lead", trigger: "click" },
  close_convert_lead: { group: "lead", trigger: "click" },
  close_unconvert_lead: { group: "lead", trigger: "click" },
} as const;

export type Ga4EventName = keyof typeof GA4_CATALOG;

/**
 * Standard GA4 item variables ← entry field mapping (e.g. item_id ← sku).
 * The official items-array parameter set (GTM ecommerce spec). creative_name/creative_slot
 * are event-level only per spec — pass them via event params, not the item mapping.
 */
const ITEM_PARAMS = [
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
] as const;

export const ga4ConfigSchema = z.object({
  /** Falls back to the workspace-wide default when unset */
  currency: z.string().length(3).optional(),
  /** GA4 item param ← entry field name */
  itemMapping: z.record(z.enum(ITEM_PARAMS), z.string()).default({}),
  /** Entry field used as the value (total) param (required for ecommerce) */
  valueField: z.string().optional(),
  events: z
    .array(
      z.object({
        event: z.enum(Object.keys(GA4_CATALOG) as [Ga4EventName, ...Ga4EventName[]]),
        /** Element the click event binds to: matched against data-ga-event in the template */
        params: z.record(z.string()).default({}),
        /**
         * Per-event items mapping. GA4 lets each event carry its own items shape
         * (purchase may add quantity/coupon that view_item has no use for), so the
         * mapping belongs to the event. Falls back to the top-level mapping when unset —
         * that is how configs written before 2026-08-22 keep working.
         */
        itemMapping: z.record(z.enum(ITEM_PARAMS), z.string()).optional(),
        valueField: z.string().optional(),
      }),
    )
    .default([]),
});

export type Ga4Config = z.infer<typeof ga4ConfigSchema>;

/** Per-event mapping wins; the top-level one is the pre-2026-08-22 fallback */
function effectiveItemMapping(
  config: Ga4Config,
  e: Ga4Config["events"][number],
): Partial<Record<(typeof ITEM_PARAMS)[number], string>> {
  return e.itemMapping ?? config.itemMapping;
}

/** Validation at save time (T5.4 DoD: reject save when unmapped) */
export function validateGa4Config(
  raw: unknown,
  workspaceCurrency: string | undefined,
): Ga4Config {
  const parsed = ga4ConfigSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    throw new ValidationError("Invalid analytics event configuration", {
      issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    });
  }
  const config = parsed.data;
  const issues: string[] = [];
  const groups = new Set(config.events.map((e) => GA4_CATALOG[e.event].group));

  if (groups.has("ecommerce") && !config.currency && !workspaceCurrency) {
    issues.push(
      "Ecommerce events need a currency — set a global default in Settings or on the event",
    );
  }
  // Requirements are per event: each one carries (or inherits) its own items mapping
  for (const e of config.events) {
    const group = GA4_CATALOG[e.event].group;
    const items = effectiveItemMapping(config, e);
    const valueField = e.valueField ?? config.valueField;
    if (group === "ecommerce" && !valueField) {
      issues.push(`${e.event}: needs a value field mapping`);
    }
    if (group !== "lead" && !items.item_id) {
      issues.push(`${e.event}: needs an item_id mapping (e.g. item_id ← sku)`);
    }
    if (
      group === "promotion" &&
      !items.promotion_id &&
      !items.promotion_name &&
      !e.params.promotion_id &&
      !e.params.promotion_name
    ) {
      issues.push(`${e.event}: needs a promotion_id or promotion_name mapping`);
    }
    // Official spec: transaction_id is required for purchase AND refund
    if ((e.event === "purchase" || e.event === "refund") && !e.params.transaction_id) {
      issues.push(`A ${e.event} event requires a transaction_id parameter mapping`);
    }
  }
  if (issues.length > 0) {
    throw new ValidationError("GA4 standard schema violation — cannot save", { issues });
  }
  return config;
}

/**
 * Per-market GA4 settings (workspaces.settings.ga4Markets).
 * A "market" is whatever the customer serves separately — a country, a region, or a locale.
 * Each market installs its own GTM container and prices in its own currency, so the
 * dataLayer we push has to match the market the page was served for.
 */
export interface Ga4Market {
  currency: string;
  /** GTM container the host page installs for this market — informational, we never load it */
  containerId?: string;
}

export function ga4Markets(settings: unknown): Record<string, Ga4Market> {
  if (!settings || typeof settings !== "object") return {};
  const m = (settings as { ga4Markets?: unknown }).ga4Markets;
  return m && typeof m === "object" ? (m as Record<string, Ga4Market>) : {};
}

/**
 * Market resolution: explicit ?market= → the entry's locale → none.
 * Currency then falls back to the workspace default, keeping single-market installs unchanged.
 */
export function resolveMarket(
  settings: unknown,
  requested: string | undefined,
  locale: string | undefined,
): { market: string | null; currency: string | undefined; containerId?: string } {
  const markets = ga4Markets(settings);
  const key = [requested, locale].find((k) => k && markets[k]) ?? null;
  const hit = key ? markets[key] : undefined;
  const fallback = (settings as { currency?: string } | null)?.currency;
  return {
    market: key,
    currency: hit?.currency ?? fallback,
    ...(hit?.containerId ? { containerId: hit.containerId } : {}),
  };
}

export interface GaRuntimePayload {
  /**
   * View events auto-pushed at render time (null if none). An array because more than one
   * view-trigger event can apply (e.g. view_item + view_promotion on a promoted product);
   * the runtimes accept both a single object (legacy payloads) and an array.
   */
  view: Array<Record<string, unknown>> | null;
  /** data-ga-event value → push payload */
  click: Record<string, Record<string, unknown>>;
  /** Market this payload was priced for (null = single-market install) */
  market?: string | null;
  /** GTM container expected on the host page for that market — lets consumers assert */
  containerId?: string;
}

/** Entry values + mapping → dataLayer push payloads (precomputed on the server) */
export function buildGaPayloads(
  config: Ga4Config,
  values: Record<string, unknown>,
  workspaceCurrency: string | undefined,
): GaRuntimePayload {
  const currency = config.currency ?? workspaceCurrency ?? "KRW";
  /** Params the official spec types as numbers — coerce mapped text fields */
  const NUMERIC_PARAMS = new Set(["price", "quantity", "discount", "index"]);
  const itemsOf = (e: Ga4Config["events"][number]): Record<string, unknown> => {
    const item: Record<string, unknown> = {};
    for (const [param, field] of Object.entries(effectiveItemMapping(config, e))) {
      const raw = values[field as string];
      if (raw === undefined || raw === null) continue;
      item[param] = NUMERIC_PARAMS.has(param) ? Number(raw) || 0 : raw;
    }
    return item;
  };
  const valueOf = (e: Ga4Config["events"][number]): number | undefined => {
    const f = e.valueField ?? config.valueField;
    return f ? Number(values[f]) || 0 : undefined;
  };

  const payloadFor = (e: Ga4Config["events"][number]): Record<string, unknown> => {
    const base: Record<string, unknown> = { event: e.event };
    const group = GA4_CATALOG[e.event].group;
    // Extra params: substitute when the value is an entry field name, else keep as a literal
    const extras: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(e.params)) {
      extras[k] = values[v] !== undefined ? values[v] : v;
    }
    const value = valueOf(e);
    if (group === "lead") {
      // Lead events have no ecommerce object — currency/value/lead params sit at top level
      base.currency = currency;
      if (value !== undefined) base.value = value;
      Object.assign(base, extras);
      return base;
    }
    // ecommerce / list / promotion: params live INSIDE the ecommerce object (GTM dataLayer
    // spec — transaction_id, item_list_*, promotion_*, shipping_tier etc. are ecommerce keys)
    base.ecommerce = {
      currency,
      // list/promotion events carry no value per spec (no revenue at that step)
      ...(group === "ecommerce" && value !== undefined ? { value } : {}),
      ...extras,
      items: [itemsOf(e)],
    };
    return base;
  };

  const view: Array<Record<string, unknown>> = [];
  const click: Record<string, Record<string, unknown>> = {};
  for (const e of config.events) {
    if (GA4_CATALOG[e.event].trigger === "view") view.push(payloadFor(e));
    else click[e.event] = payloadFor(e);
  }
  return { view: view.length > 0 ? view : null, click };
}
