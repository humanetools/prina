/**
 * MCP core smoke (follow-up to IMPL-ee-boundary §6) — detailed scenarios in test/ee/mcp.test.ts.
 * Since mcp.test lives in test/ee due to EE coupling (guard/audit assertions), this
 * guarantees the core MCP 2-plane paths (handshake→tools/list→tools/call, published-only)
 * even under the OSS gate.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { DefaultRole, McpPlane } from "@prina/shared";
import { buildApp } from "../src/app.js";
import { createDb } from "../src/db/client.js";
import { contentTypeCreate } from "../src/modules/content-type/commands.js";
import { entryCreate } from "../src/modules/entry/commands.js";
import { mcpTokenCreate } from "../src/modules/mcp/tokens.js";
import { publishEntry, setupTestContext, type TestContext } from "./helpers.js";
import { articleDefinition } from "./fixtures.js";

let t: TestContext;
let app: FastifyInstance;
let mgmtToken: string;
let dlvToken: string;

class McpClient {
  sessionId: string | undefined;
  private nextId = 1;
  constructor(
    private plane: string,
    private bearer: string,
  ) {}

  async rpc(method: string, params: Record<string, unknown> = {}) {
    const res = await app.inject({
      method: "POST",
      url: `/mcp/${this.plane}`,
      headers: {
        authorization: `Bearer ${this.bearer}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
      },
      payload: { jsonrpc: "2.0", id: this.nextId++, method, params },
    });
    if (res.headers["mcp-session-id"]) {
      this.sessionId = res.headers["mcp-session-id"] as string;
    }
    return res;
  }

  async init() {
    const res = await this.rpc("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "smoke", version: "1.0" },
    });
    expect(res.statusCode).toBe(200);
  }
}

function parseResult(body: string): { result?: { tools?: Array<{ name: string }>; content?: Array<{ text: string }> } } {
  if (body.trimStart().startsWith("{")) return JSON.parse(body);
  const events = body.split("\n\n").filter((b) => b.includes("data:"));
  const last = events[events.length - 1]!;
  const data = last
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim())
    .join("");
  return JSON.parse(data);
}

beforeAll(async () => {
  t = await setupTestContext();
  const { db } = createDb(process.env.TEST_DATABASE_URL!);
  // ee not injected — verifies the core-only MCP path (purpose of the OSS gate)
  app = buildApp({
    env: { LOG_LEVEL: "error", NODE_ENV: "test", ADMIN_DIST_PATH: undefined, S3_REGION: "us-east-1" } as Parameters<typeof buildApp>[0]["env"],
    db,
    services: t.services,
  });
  await contentTypeCreate.run(
    { uid: "article", name: "아티클", definition: articleDefinition },
    t.ctx,
  );
  const pub = await entryCreate.run(
    { typeUid: "article", values: { title: "발행 기사" } },
    t.ctx,
  );
  await publishEntry(t.ctx, "article", pub.entry.id);
  await entryCreate.run({ typeUid: "article", values: { title: "초안 기사" } }, t.ctx);

  mgmtToken = (
    await mcpTokenCreate.run(
      { plane: McpPlane.Management, name: "smoke-ops", roleId: t.roleId(DefaultRole.Editor) },
      t.ctx,
    )
  ).token;
  dlvToken = (
    await mcpTokenCreate.run({ plane: McpPlane.Delivery, name: "smoke-site" }, t.ctx)
  ).token;
});
afterAll(async () => {
  await app.close();
  await t.cleanup();
});

describe("MCP core smoke", () => {
  it("management: handshake → type tools in tools/list → article_list call", async () => {
    const c = new McpClient("management", mgmtToken);
    await c.init();
    const list = await c.rpc("tools/list");
    const tools = parseResult(list.body).result?.tools?.map((x) => x.name) ?? [];
    expect(tools).toContain("article_list");
    const call = await c.rpc("tools/call", { name: "article_list", arguments: {} });
    const text = parseResult(call.body).result?.content?.[0]?.text ?? "";
    expect(text).toContain("발행 기사");
    expect(text).toContain("초안 기사"); // management can also read drafts
  });

  it("delivery: published-only — drafts are not visible", async () => {
    const c = new McpClient("delivery", dlvToken);
    await c.init();
    const call = await c.rpc("tools/call", { name: "article_list", arguments: {} });
    const text = parseResult(call.body).result?.content?.[0]?.text ?? "";
    expect(text).toContain("발행 기사");
    expect(text).not.toContain("초안 기사");
  });

  it("rejects requests without a token", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/mcp/management",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });
    expect(res.statusCode).toBe(401);
  });
});
