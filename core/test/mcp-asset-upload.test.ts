/**
 * Asset upload over MCP (58-IMPL): Prina hands out a one-time upload address, the agent PUTs the file
 * there, then confirms. The file never travels through MCP. A workspace can switch the tools off.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { DefaultRole, McpPlane } from "@prina/shared";
import { buildApp } from "../src/app.js";
import { createDb } from "../src/db/client.js";
import { mcpTokenCreate } from "../src/modules/mcp/tokens.js";
import { workspaceUpdateSettings } from "../src/modules/workspace/commands.js";
import { absoluteUploadUrl } from "../src/mcp/asset-tools.js";
import { setupTestContext, type TestContext } from "./helpers.js";

let t: TestContext;
let app: FastifyInstance;
let bearer: string;
let viewerBearer: string;

// A 1×1 transparent PNG
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

function parseBody(body: string): { result?: { tools?: Array<{ name: string }>; content?: Array<{ text: string }>; isError?: boolean } } {
  if (body.trimStart().startsWith("{")) return JSON.parse(body);
  const data = body.split("\n").filter((l) => l.startsWith("data: ")).at(-1);
  return data ? JSON.parse(data.slice(6)) : {};
}

class McpClient {
  sessionId: string | undefined;
  private nextId = 1;
  constructor(private token: () => string) {}
  async rpc(method: string, params: Record<string, unknown> = {}) {
    const res = await app.inject({
      method: "POST",
      url: `/mcp/${McpPlane.Management}`,
      headers: {
        authorization: `Bearer ${this.token()}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        host: "cms.example.test",
        "x-forwarded-proto": "https",
        ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
      },
      payload: { jsonrpc: "2.0", id: this.nextId++, method, params },
    });
    if (res.headers["mcp-session-id"]) this.sessionId = res.headers["mcp-session-id"] as string;
    return res;
  }
  async init() {
    await this.rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1.0" } });
  }
  async toolNames() {
    return (parseBody((await this.rpc("tools/list")).body).result?.tools ?? []).map((x) => x.name);
  }
  async call(name: string, args: Record<string, unknown>) {
    const parsed = parseBody((await this.rpc("tools/call", { name, arguments: args })).body);
    const text = parsed.result?.content?.[0]?.text ?? "";
    return { json: (() => { try { return JSON.parse(text); } catch { return null; } })(), text, isError: parsed.result?.isError === true };
  }
}

beforeAll(async () => {
  t = await setupTestContext();
  const { db } = createDb(process.env.TEST_DATABASE_URL!);
  app = buildApp({ env: { LOG_LEVEL: "error", NODE_ENV: "test", ADMIN_DIST_PATH: undefined, S3_REGION: "us-east-1", TRUST_PROXY: "true" }, db, services: t.services });
  bearer = (await mcpTokenCreate.run({ name: "asset-upload-test", plane: McpPlane.Management, roleId: t.roleId(DefaultRole.Admin) }, t.ctx)).token;
  viewerBearer = (await mcpTokenCreate.run({ name: "asset-upload-viewer", plane: McpPlane.Management, roleId: t.roleId(DefaultRole.Publisher) }, t.ctx)).token;
});

afterAll(async () => {
  await workspaceUpdateSettings.run({ settings: { mcp: null } }, t.ctx);
  await app.close();
  await t.cleanup();
});

describe("asset upload over MCP", () => {
  it("makes a relative upload address absolute against the address the agent called", () => {
    expect(absoluteUploadUrl("/api/assets/local-upload?key=a", "https://cms.example.test")).toBe("https://cms.example.test/api/assets/local-upload?key=a");
    expect(absoluteUploadUrl("https://bucket.s3.example/a?sig=1", "https://cms.example.test")).toBe("https://bucket.s3.example/a?sig=1");
  });

  it("request → PUT the file to the address → confirm: the asset is ready, and the file never went through MCP", async () => {
    const client = new McpClient(() => bearer);
    await client.init();
    const names = await client.toolNames();
    expect(names).toContain("asset_request_upload");
    expect(names).toContain("asset_confirm_upload");

    const req = await client.call("asset_request_upload", { filename: "dot.png", mime: "image/png", size: PNG.length, folder: "/mcp" });
    expect(req.isError).toBe(false);
    const { asset, upload } = req.json as { asset: { id: string; status: string }; upload: { url: string; method: string; expiresIn: number } };
    expect(asset.status).toBe("uploading");
    expect(upload.method).toBe("PUT");
    // local storage: a path on Prina, handed back as an absolute address on the host the agent called
    expect(upload.url.startsWith("https://cms.example.test/api/assets/local-upload?")).toBe(true);

    const notYet = await client.call("asset_confirm_upload", { id: asset.id });
    expect(notYet.isError).toBe(true);

    // no session: the signed address alone is the credential — a tampered one is refused
    const path = upload.url.replace("https://cms.example.test", "");
    const forged = await app.inject({ method: "PUT", url: path.replace(/sig=[^&]+/, "sig=00"), headers: { "content-type": "image/png" }, payload: PNG });
    expect(forged.statusCode).toBe(403);
    const put = await app.inject({ method: "PUT", url: path, headers: { "content-type": "image/png" }, payload: PNG });
    expect(put.statusCode).toBe(200);

    const done = await client.call("asset_confirm_upload", { id: asset.id });
    expect(done.isError).toBe(false);
    expect(done.json).toMatchObject({ id: asset.id, status: "ready", width: 1, height: 1, folder: "/mcp" });
  });

  it("follows the token's role: a role without media create cannot ask for an address", async () => {
    const client = new McpClient(() => viewerBearer);
    await client.init();
    const res = await client.call("asset_request_upload", { filename: "x.png", mime: "image/png", size: 10 });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/FORBIDDEN|permission/i);
  });

  it("switched off in the workspace, the tools are not offered — no reconnect needed", async () => {
    const client = new McpClient(() => bearer);
    await client.init();
    expect(await client.toolNames()).toContain("asset_request_upload");
    await workspaceUpdateSettings.run({ settings: { mcp: { agentUploads: false } } }, t.ctx);
    const names = await client.toolNames();
    expect(names).not.toContain("asset_request_upload");
    expect(names).not.toContain("asset_confirm_upload");
    const refused = await client.call("asset_request_upload", { filename: "x.png", mime: "image/png", size: 10 });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("UNKNOWN_TOOL");
    await workspaceUpdateSettings.run({ settings: { mcp: { agentUploads: true } } }, t.ctx);
    expect(await client.toolNames()).toContain("asset_request_upload");
  });
});
