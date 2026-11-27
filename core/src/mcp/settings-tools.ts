/**
 * Workspace settings tools (management plane) — the SEO/GEO/GA4 surface.
 *
 * These three are Prina's differentiators, but MCP QA (2026-08-24) found them unreachable from
 * an agent: the models existed (workspaces.settings.seo, .ga4Markets, .currency) with no tool
 * to read or write them, so a session driving the whole CMS over MCP had to break out to the
 * admin UI for exactly the features being demonstrated.
 *
 * Settings are a merge patch at the top level, so writing one key never clears the others —
 * but a nested object IS replaced wholesale, which the descriptions say out loud.
 */
import type { CommandCtx } from "../commands/context.js";
import {
  workspaceGetSettings,
  workspaceUpdateSettings,
} from "../modules/workspace/commands.js";
import type { McpToolDef } from "./tools.js";

type Json = Record<string, unknown>;
type Handler = (args: Json) => Promise<unknown>;

export function addSettingsTools(
  add: (tool: McpToolDef, handler: Handler) => void,
  ctx: CommandCtx,
): void {
  add(
    {
      name: "workspace_settings_get",
      description:
        "Read workspace settings — SEO/GEO defaults (seo.siteBaseUrl, titleSuffix, robots), " +
        "GA4 market config (ga4Markets, currency) and any other stored keys. Read this before " +
        "writing: workspace_settings_update replaces nested objects whole.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    () => workspaceGetSettings.run({}, ctx),
  );

  add(
    {
      name: "workspace_settings_update",
      description:
        "Update workspace settings by merge patch — top-level keys you omit are untouched, but a " +
        "nested object you send REPLACES the stored one (send the full object, not a fragment). " +
        "`seo.siteBaseUrl` is what makes canonical URLs, sitemap.xml and llms.txt absolute — " +
        "without it those GEO surfaces fall back to the request origin. `ga4Markets` supplies the " +
        "currency and GTM container the delivery dataLayer pushes per market.",
      inputSchema: {
        type: "object",
        required: ["settings"],
        properties: {
          settings: {
            type: "object",
            properties: {
              seo: {
                type: "object",
                description: "Workspace-wide SEO/GEO defaults",
                properties: {
                  siteBaseUrl: {
                    type: "string",
                    description:
                      "Customer site origin for canonical and sitemap URLs, no trailing slash (https://example.com)",
                  },
                  titleSuffix: {
                    type: "string",
                    description: 'Appended to every meta title, e.g. " | Acme"',
                  },
                  defaultOgImage: {
                    type: "string",
                    format: "uuid",
                    description: "DAM asset id used as the og:image fallback",
                  },
                  robots: {
                    type: "object",
                    description: "robots.txt additions",
                    properties: {
                      extraDisallow: { type: "array", items: { type: "string" } },
                    },
                  },
                },
              },
              currency: {
                type: "string",
                minLength: 3,
                maxLength: 3,
                description: "Default ISO-4217 currency for GA4 ecommerce events (e.g. KRW)",
              },
              ga4Markets: {
                type: "object",
                description:
                  "Per-market GA4 config keyed by market — a country, region or locale code. " +
                  'e.g. {"ko":{"currency":"KRW","containerId":"GTM-XXXX"}}. Delivery resolves the ' +
                  "market from ?market= then the entry locale, falling back to the default currency.",
                additionalProperties: {
                  type: "object",
                  required: ["currency"],
                  properties: {
                    currency: { type: "string", minLength: 3, maxLength: 3 },
                    containerId: {
                      type: "string",
                      description: "GTM container the host page installs — informational, Prina never loads it",
                    },
                  },
                },
              },
            },
            additionalProperties: true,
          },
        },
      },
    },
    (args) => workspaceUpdateSettings.run(args, ctx),
  );
}
