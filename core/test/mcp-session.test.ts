/**
 * Streamable HTTP session lifecycle + tool error surface.
 *
 * Why this exists: sessions live in process memory, so every core restart invalidates the
 * session id the client is holding. The spec says an unrecognized Mcp-Session-Id must answer
 * 404, which is the client's signal to re-initialize; anything else (we used to send 400)
 * reads as a hard failure and the connector stays dead until the user reconnects by hand.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { DefaultRole, McpPlane } from "@prina/shared";
import { buildApp } from "../src/app.js";
import { createDb } from "../src/db/client.js";
import { mcpTokenCreate } from "../src/modules/mcp/tokens.js";
import { setupTestContext, type TestContext } from "./helpers.js";

let t: TestContext;
let app: FastifyInstance;
let bearer: string;

const STALE_SESSION = "00000000-dead-beef-0000-000000000000";

function parseBody(body: string): Record<string, any> {
  if (body.trimStart().startsWith("{")) return JSON.parse(body);
  const data = body.split("\n").filter((l) => l.startsWith("data: ")).at(-1);
  return data ? JSON.parse(data.slice(6)) : {};
}

const post = (payload: Record<string, unknown>, sessionId?: string) =>
  app.inject({
    method: "POST",
    url: `/mcp/${McpPlane.Management}`,
    headers: {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    payload,
  });

const initPayload = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
};

beforeAll(async () => {
  t = await setupTestContext();
  const { db } = createDb(process.env.TEST_DATABASE_URL!);
  app = buildApp({
    env: { LOG_LEVEL: "error", NODE_ENV: "test", ADMIN_DIST_PATH: undefined, S3_REGION: "us-east-1" },
    db,
    services: t.services,
  });
  const issued = await mcpTokenCreate.run(
    { name: "session-test", plane: McpPlane.Management, roleId: t.roleId(DefaultRole.Admin) },
    t.ctx,
  );
  bearer = issued.token;
});

afterAll(async () => {
  await app.close();
  await t.cleanup();
});

describe("session recovery after a restart", () => {
  it("a request carrying an unknown session id answers 404, not 400", async () => {
    const res = await post(
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      STALE_SESSION,
    );
    // 404 is the spec's signal to start a new session; 400 leaves the client stuck
    expect(res.statusCode).toBe(404);
  });

  it("initialize with a stale session id still starts a fresh session", async () => {
    const res = await post(initPayload, STALE_SESSION);
    expect(res.statusCode).toBe(200);
    expect(res.headers["mcp-session-id"]).toBeTruthy();
    expect(res.headers["mcp-session-id"]).not.toBe(STALE_SESSION);
  });

  it("GET stream with an unknown session id answers 404", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/mcp/${McpPlane.Management}`,
      headers: {
        authorization: `Bearer ${bearer}`,
        accept: "text/event-stream",
        "mcp-session-id": STALE_SESSION,
      },
    });
    expect(res.statusCode).toBe(404);
  });

  it("a request with no session id at all still asks for initialize (400)", async () => {
    // No session header = the client never initialized; 404 would wrongly suggest a dead session
    const res = await post({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} });
    expect(res.statusCode).toBe(400);
  });
});

describe("tool error surface", () => {
  it("an unexpected failure returns its message and code, not a bare 'Internal error'", async () => {
    const init = await post(initPayload);
    const sid = init.headers["mcp-session-id"] as string;
    // Unknown content type → NotFoundError from the command pipeline
    const res = await post(
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "entry_list", arguments: { uid: "does_not_exist" } },
      },
      sid,
    );
    const result = parseBody(res.body).result;
    expect(result.isError).toBe(true);
    const text = result.content[0].text as string;
    const payload = JSON.parse(text) as { error: { code: string; message: string } };
    expect(payload.error.code).toBeTruthy();
    expect(payload.error.message).not.toBe("Internal error");
    expect(text).toContain("does_not_exist");
  });

  it("an unknown tool name says so with a code", async () => {
    const init = await post(initPayload);
    const sid = init.headers["mcp-session-id"] as string;
    const res = await post(
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "no_such_tool", arguments: {} } },
      sid,
    );
    const result = parseBody(res.body).result;
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text as string) as {
      error: { code: string; message: string };
    };
    expect(payload.error.code).toBe("UNKNOWN_TOOL");
    expect(payload.error.message).toContain("no_such_tool");
  });
});
