/**
 * MCP surface gaps found in the 2026-08-24 QA build (24 types, ~480 entries driven purely
 * over MCP). Every one of these was a command that existed with no tool in front of it, so
 * these tests fix the surface, not the engine:
 *   component_* (component/dynamic_zone fields could be declared but never filled)
 *   entry_set_seo · schemaOrgType/options on content_type_* (SEO + JSON-LD)
 *   workspace_settings_* (GEO defaults, GA4 markets)
 *   bulk failures naming the offending field · unicode slugs · a transition refusal that explains itself
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { DefaultRole, EntryStatus, McpPlane } from "@prina/shared";
import { eq } from "drizzle-orm";
import { workflowTransitions } from "../src/db/schema/index.js";
import { buildApp } from "../src/app.js";
import { createDb } from "../src/db/client.js";
import { mcpTokenCreate } from "../src/modules/mcp/tokens.js";
import { setupTestContext, type TestContext } from "./helpers.js";

let t: TestContext;
let app: FastifyInstance;
let bearer: string;

function parseBody(body: string): {
  result?: { tools?: Array<{ name: string }>; content?: Array<{ text: string }>; isError?: boolean };
} {
  if (body.trimStart().startsWith("{")) return JSON.parse(body);
  const data = body.split("\n").filter((l) => l.startsWith("data: ")).at(-1);
  return data ? JSON.parse(data.slice(6)) : {};
}

class McpClient {
  sessionId: string | undefined;
  private nextId = 1;

  async rpc(method: string, params: Record<string, unknown> = {}) {
    const res = await app.inject({
      method: "POST",
      url: `/mcp/${McpPlane.Management}`,
      headers: {
        authorization: `Bearer ${bearer}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
      },
      payload: { jsonrpc: "2.0", id: this.nextId++, method, params },
    });
    if (res.headers["mcp-session-id"]) this.sessionId = res.headers["mcp-session-id"] as string;
    return res;
  }

  async call(name: string, args: Record<string, unknown>) {
    const res = await this.rpc("tools/call", { name, arguments: args });
    expect(res.statusCode).toBe(200);
    const parsed = parseBody(res.body);
    return { text: parsed.result?.content?.[0]?.text ?? "", isError: parsed.result?.isError === true };
  }
}

const client = new McpClient();

beforeAll(async () => {
  t = await setupTestContext();
  const { db } = createDb(process.env.TEST_DATABASE_URL!);
  app = buildApp({
    env: { LOG_LEVEL: "error", NODE_ENV: "test", ADMIN_DIST_PATH: undefined, S3_REGION: "us-east-1" },
    db,
    services: t.services,
  });
  const issued = await mcpTokenCreate.run(
    { name: "qa-gaps", plane: McpPlane.Management, roleId: t.roleId(DefaultRole.Admin) },
    t.ctx,
  );
  bearer = issued.token;
  await client.rpc("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "test", version: "1.0" },
  });
});

afterAll(async () => {
  await app.close();
  await t.cleanup();
});

describe("component tools (P0 — component/dynamic_zone were unfillable)", () => {
  it("component_create then a component field accepts a value", async () => {
    const made = await client.call("component_create", {
      uid: "seo_box",
      name: "SEO box",
      definition: { fields: [{ name: "headline", type: "text" }, { name: "blurb", type: "text" }] },
    });
    expect(made.isError, made.text).toBe(false);

    const type = await client.call("content_type_create", {
      uid: "page",
      name: "Page",
      definition: {
        fields: [
          { name: "title", type: "text", required: true },
          { name: "box", type: "component", component: "seo_box" },
        ],
        displayField: "title",
      },
    });
    expect(type.isError, type.text).toBe(false);

    // The value that used to be rejected with "must be null" / "missing component"
    const entry = await client.call("entry_create", {
      uid: "page",
      values: { title: "Home", box: { headline: "Hi", blurb: "There" } },
    });
    expect(entry.isError, entry.text).toBe(false);
    expect(entry.text).toContain("Hi");
  });

  it("dynamic_zone blocks accept values once their components exist", async () => {
    for (const uid of ["hero_b", "quote_b"]) {
      const c = await client.call("component_create", {
        uid,
        name: uid,
        definition: { fields: [{ name: "text", type: "text" }] },
      });
      expect(c.isError, c.text).toBe(false);
    }
    const type = await client.call("content_type_create", {
      uid: "landing",
      name: "Landing",
      definition: {
        fields: [
          { name: "title", type: "text", required: true },
          { name: "sections", type: "dynamic_zone", components: ["hero_b", "quote_b"] },
        ],
        displayField: "title",
      },
    });
    expect(type.isError, type.text).toBe(false);

    const entry = await client.call("entry_create", {
      uid: "landing",
      values: {
        title: "L1",
        sections: [
          { __component: "hero_b", text: "big" },
          { __component: "quote_b", text: "said" },
        ],
      },
    });
    expect(entry.isError, entry.text).toBe(false);
    expect(entry.text).toContain("hero_b");
  });

  it("component_list shows what a component field may reference", async () => {
    const listed = await client.call("component_list", {});
    expect(listed.isError).toBe(false);
    expect(listed.text).toContain("seo_box");
  });
});

describe("SEO / JSON-LD tools (P0-2 — model existed, no write surface)", () => {
  it("content_type_create carries schemaOrgType and options.seo", async () => {
    const made = await client.call("content_type_create", {
      uid: "item",
      name: "Item",
      schemaOrgType: "Product",
      options: { seo: { enabled: true, urlPattern: "/items/{slug}", sitemap: { include: true } } },
      definition: {
        fields: [
          { name: "title", type: "text", required: true },
          { name: "slug", type: "uid", targetField: "title" },
        ],
        displayField: "title",
      },
    });
    expect(made.isError, made.text).toBe(false);
    expect(made.text).toContain("Product");

    const listed = await client.call("content_type_list", {});
    const item = (JSON.parse(listed.text) as Array<{ uid: string; schemaOrgType: string | null }>)
      .find((row) => row.uid === "item");
    expect(item?.schemaOrgType).toBe("Product");
  });

  it("entry_set_seo writes the record entry_get was already showing as null", async () => {
    const created = await client.call("entry_create", { uid: "item", values: { title: "Widget" } });
    expect(created.isError, created.text).toBe(false);
    const id = JSON.parse(created.text).entry.id as string;

    const set = await client.call("entry_set_seo", {
      uid: "item",
      id,
      seo: { metaTitle: "Widget — buy", metaDescription: "A widget", noindex: false },
    });
    expect(set.isError, set.text).toBe(false);

    const got = await client.call("entry_get", { uid: "item", id });
    expect(got.text).toContain("Widget — buy");

    // Full-replace semantics: null clears the record
    const cleared = await client.call("entry_set_seo", { uid: "item", id, seo: null });
    expect(cleared.isError, cleared.text).toBe(false);
    expect(JSON.parse(cleared.text).entry.seo).toBeNull();
  });
});

describe("workspace settings tools (P1-2 — GEO/GA4 were unreachable)", () => {
  it("update then read back siteBaseUrl and a GA4 market", async () => {
    const updated = await client.call("workspace_settings_update", {
      settings: {
        seo: { siteBaseUrl: "https://shop.example.com", titleSuffix: " | Shop" },
        currency: "KRW",
        ga4Markets: { ko: { currency: "KRW", containerId: "GTM-TEST" } },
      },
    });
    expect(updated.isError, updated.text).toBe(false);

    const got = await client.call("workspace_settings_get", {});
    expect(got.text).toContain("https://shop.example.com");
    expect(got.text).toContain("GTM-TEST");
  });
});

describe("error DX and slugs", () => {
  it("bulk failures name the offending field (P2)", async () => {
    const res = await client.call("entry_bulk_create", {
      uid: "item",
      items: [{ values: { title: "ok" } }, { values: { title: "bad", nosuchfield: 1 } }],
    });
    expect(res.isError, res.text).toBe(false);
    const body = JSON.parse(res.text) as {
      createdCount: number;
      failed: Array<{ index: number; error: string; issues?: string[] }>;
    };
    expect(body.createdCount).toBe(1);
    expect(body.failed).toHaveLength(1);
    // Used to be just "Values violate the content type schema" with no way to tell which field
    expect(body.failed[0]!.issues?.join(" ")).toMatch(/additional propert/i);
  });

  it("a refused transition lists what the workflow does allow (P1)", async () => {
    const created = await client.call("entry_create", { uid: "item", values: { title: "T" } });
    const id = JSON.parse(created.text).entry.id as string;

    // Which states exist depends on the preset (core seeds draft↔published, EE the 4-state
    // chain), so refuse-test a transition no preset defines rather than guessing.
    const defined = await t.ctx.db
      .select({ from: workflowTransitions.fromState, to: workflowTransitions.toState })
      .from(workflowTransitions)
      .where(eq(workflowTransitions.workspaceId, t.ctx.workspaceId));
    const target = [EntryStatus.Review, EntryStatus.Approved, EntryStatus.Published].find(
      (to) => !defined.some((d) => d.from === EntryStatus.Draft && d.to === to),
    )!;

    const res = await client.call("entry_transition", { uid: "item", id, to: target });
    expect(res.isError, res.text).toBe(true);
    expect(res.text).toContain(`draft → ${target}`);
    // The refusal must say what IS possible, not just what is not
    expect(res.text).toMatch(/this workflow allows:|no transition out of/i);
  });

  it("Korean titles produce readable slugs instead of an id fallback (P3)", async () => {
    const created = await client.call("entry_create", {
      uid: "item",
      values: { title: "리어 스피커 키트" },
    });
    expect(created.isError, created.text).toBe(false);
    expect(JSON.parse(created.text).entry.values.slug).toBe("리어-스피커-키트");

    const ascii = await client.call("entry_create", { uid: "item", values: { title: "Galaxy S25 Ultra" } });
    expect(JSON.parse(ascii.text).entry.values.slug).toBe("galaxy-s25-ultra");
  });
});
