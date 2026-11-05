/**
 * Static entry tools — acceptance for the "one session, no reconnect" flow:
 * type create → entry create → relation link → list → transition, all through a single
 * MCP session whose tool list was fetched BEFORE the types existed.
 * Also covers the definition error DX (allowedTypes, did-you-mean, availableTypes).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { DefaultRole, EntryStatus, McpPlane } from "@prina/shared";
import { buildApp } from "../src/app.js";
import { createDb } from "../src/db/client.js";
import { mcpTokenCreate } from "../src/modules/mcp/tokens.js";
import { workflowTransitions } from "../src/db/schema/index.js";
import { and, eq } from "drizzle-orm";
import { setupTestContext, type TestContext } from "./helpers.js";

let t: TestContext;
let app: FastifyInstance;
let bearer: string;

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
    if (res.headers["mcp-session-id"]) {
      this.sessionId = res.headers["mcp-session-id"] as string;
    }
    return res;
  }

  async call(name: string, args: Record<string, unknown>) {
    const res = await this.rpc("tools/call", { name, arguments: args });
    expect(res.statusCode).toBe(200);
    const parsed = parseBody(res.body);
    const text = parsed.result?.content?.[0]?.text ?? "";
    return { text, isError: parsed.result?.isError === true };
  }
}

function parseBody(body: string): {
  result?: { tools?: Array<{ name: string }>; content?: Array<{ text: string }>; isError?: boolean };
} {
  if (body.trimStart().startsWith("{")) return JSON.parse(body);
  // SSE frame: take the last data: line
  const data = body.split("\n").filter((l) => l.startsWith("data: ")).at(-1);
  return data ? JSON.parse(data.slice(6)) : {};
}

beforeAll(async () => {
  t = await setupTestContext();
  const { db } = createDb(process.env.TEST_DATABASE_URL!);
  app = buildApp({
    env: { LOG_LEVEL: "error", NODE_ENV: "test", ADMIN_DIST_PATH: undefined, S3_REGION: "us-east-1" },
    db,
    services: t.services,
  });
  const issued = await mcpTokenCreate.run(
    { name: "static-tools-test", plane: McpPlane.Management, roleId: t.roleId(DefaultRole.Admin) },
    t.ctx,
  );
  bearer = issued.token;
});

afterAll(async () => {
  await app.close();
  await t.cleanup();
});

describe("static entry tools — one session, no reconnect", () => {
  const client = new McpClient();

  it("tool list fetched on an empty workspace already contains the entry_* set", async () => {
    await client.rpc("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0" },
    });
    const res = await client.rpc("tools/list");
    const names = (parseBody(res.body).result?.tools ?? []).map((tool) => tool.name);
    for (const n of ["entry_create", "entry_bulk_create", "entry_get", "entry_list", "entry_update", "entry_transition"]) {
      expect(names).toContain(n);
    }
    expect(names.some((n) => n.startsWith("category_"))).toBe(false); // no types yet
  });

  it("type create → entry create → relation → list → transition, same session", async () => {
    const cat = await client.call("content_type_create", {
      uid: "category",
      name: "Category",
      definition: { fields: [{ name: "name", type: "text", required: true }], displayField: "name" },
    });
    expect(cat.isError).toBe(false);
    const post = await client.call("content_type_create", {
      uid: "post",
      name: "Post",
      definition: {
        fields: [
          { name: "title", type: "text", required: true },
          { name: "category", type: "relation", target: "category", relationKind: "manyToOne" },
        ],
        displayField: "title",
      },
    });
    expect(post.isError).toBe(false);

    // Per-type tools were NOT in this session's tool list — the static set must carry the flow
    const catEntry = await client.call("entry_create", { uid: "category", values: { name: "News" } });
    expect(catEntry.isError).toBe(false);
    const catId = (JSON.parse(catEntry.text) as { entry: { id: string } }).entry.id;

    const postEntry = await client.call("entry_create", {
      uid: "post",
      values: { title: "Hello", category: catId },
    });
    expect(postEntry.isError).toBe(false);
    const postId = (JSON.parse(postEntry.text) as { entry: { id: string } }).entry.id;

    const list = await client.call("entry_list", { uid: "post" });
    expect(list.isError).toBe(false);
    expect(list.text).toContain(postId);

    // The two editions have disjoint transition paths (OSS: draft↔published,
    // EE: draft→review→approved→published), so ask the workspace's workflow what is
    // actually allowed from draft instead of hardcoding a target that only one edition has
    const [next] = await t.db
      .select({ to: workflowTransitions.toState })
      .from(workflowTransitions)
      .where(
        and(
          eq(workflowTransitions.workspaceId, t.workspaceId),
          eq(workflowTransitions.fromState, EntryStatus.Draft),
        ),
      )
      .limit(1);
    expect(next).toBeDefined();

    const moved = await client.call("entry_transition", { uid: "post", id: postId, to: next!.to });
    expect(moved.isError).toBe(false);

    const got = await client.call("entry_get", { uid: "post", id: postId });
    expect(got.text).toContain(`"${next!.to}"`);
  });

  it("entry_delete removes one entry, leaving the type intact", async () => {
    const made = await client.call("entry_create", { uid: "category", values: { name: "Temp" } });
    const id = (JSON.parse(made.text) as { entry: { id: string } }).entry.id;

    const gone = await client.call("entry_delete", { uid: "category", id });
    expect(gone.isError).toBe(false);

    const after = await client.call("entry_get", { uid: "category", id });
    expect(after.isError).toBe(true);
    const list = await client.call("content_type_list", {});
    expect(list.text).toContain("category");
  });

  it("content_type_delete refuses while entries exist, and says how many", async () => {
    const r = await client.call("content_type_delete", { uid: "post" });
    expect(r.isError).toBe(true);
    // An agent cannot see what the cascade would destroy — the count has to come back to it
    expect(r.text).toContain("entryCount");
    expect(r.text).toContain("passForceToConfirm");

    const forced = await client.call("content_type_delete", { uid: "post", force: true });
    expect(forced.isError).toBe(false);
    const list = await client.call("content_type_list", {});
    expect(list.text).not.toContain('"post"');
  });

  it("content_type_delete needs no force once the type is empty", async () => {
    await client.call("content_type_create", {
      uid: "empty_type",
      name: "Empty",
      definition: { fields: [{ name: "name", type: "text" }] },
    });
    const r = await client.call("content_type_delete", { uid: "empty_type" });
    expect(r.isError).toBe(false);
  });

  it("content_type_update replaces the field list", async () => {
    const r = await client.call("content_type_update", {
      uid: "category",
      definition: {
        fields: [
          { name: "name", type: "text", required: true },
          { name: "blurb", type: "text" },
        ],
        displayField: "name",
      },
    });
    expect(r.isError).toBe(false);
    const list = await client.call("content_type_list", {});
    expect(list.text).toContain("blurb");
  });

  it("unknown uid answers with the available type list", async () => {
    const r = await client.call("entry_list", { uid: "nope" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("availableTypes");
    expect(r.text).toContain("category");
  });

  it("unknown field type answers with a did-you-mean hint and allowedTypes", async () => {
    const r = await client.call("content_type_create", {
      uid: "broken",
      name: "Broken",
      definition: { fields: [{ name: "title", type: "string" }] },
    });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("did you mean 'text'");
    expect(r.text).toContain("allowedTypes");
  });

  it("shape errors return the expected skeleton", async () => {
    const r = await client.call("content_type_create", {
      uid: "broken2",
      name: "Broken2",
      definition: { attributes: { title: { type: "string" } } },
    });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("expected");
    expect(r.text).toContain("fields");
  });
});
