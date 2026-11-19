/**
 * Cloud MCP connect tokens (19-IMPL-cloud-mcp §4): a `pmt_ct_` bearer signed by the control plane
 * opens /mcp/:plane on a Cloud tenant — bound to plane + Host, expiring, no mcp_tokens row.
 * Absent ONE_TIME_LOGIN_PUBLIC_KEY (self-hosted) the token is just an invalid bearer.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrivateKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { McpPlane } from "@prina/shared";
import { buildApp } from "../src/app.js";
import { createDb } from "../src/db/client.js";
import {
  CONNECT_TOKEN_PREFIX, ConnectTokenError, MAX_CONNECT_LIFETIME_SEC, verifyConnectToken, type ConnectPayload,
} from "../src/modules/mcp/connect-token.js";
import { setupTestContext, type TestContext } from "./helpers.js";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const privPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const pubPem = publicKey.export({ type: "spki", format: "pem" }).toString();
const otherPriv = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const HOST = "acme.prina.app";

function payload(over: Partial<ConnectPayload> = {}): ConnectPayload {
  const iat = Math.floor(Date.now() / 1000);
  return {
    v: 1, purpose: "mcp", sub: "acct_1", tenant: "acme", plane: "management", hosts: [HOST, "www.acme.com"],
    client: "Claude", iat, exp: iat + 600, jti: randomUUID(), ...over,
  };
}
function signToken(p: ConnectPayload, key = privPem): string {
  const body = Buffer.from(JSON.stringify(p), "utf8");
  const sig = sign(null, body, createPrivateKey(key));
  return `${CONNECT_TOKEN_PREFIX}${body.toString("base64url")}.${sig.toString("base64url")}`;
}

describe("verifyConnectToken", () => {
  const ok: { plane: "management" | "delivery"; host: string } = { plane: "management", host: `${HOST}:443` };
  it("accepts a well-formed token for the right plane and host (port ignored, case-insensitive)", () => {
    const p = payload();
    expect(verifyConnectToken(signToken(p), pubPem, ok).jti).toBe(p.jti);
    expect(verifyConnectToken(signToken(p), pubPem, { plane: "management", host: "WWW.ACME.COM" }).tenant).toBe("acme");
  });
  it("rejects: other key, wrong host, wrong plane, expired, too long, missing prefix, bad json", () => {
    const reason = (raw: string, exp = ok) => {
      try { verifyConnectToken(raw, pubPem, exp); return "accepted"; } catch (e) { return (e as ConnectTokenError).reason; }
    };
    expect(reason(signToken(payload(), otherPriv))).toBe("bad_signature");
    expect(reason(signToken(payload()), { plane: "management", host: "other.prina.app" })).toBe("wrong_host");
    expect(reason(signToken(payload()), { plane: "delivery", host: HOST })).toBe("wrong_plane");
    const iat = Math.floor(Date.now() / 1000) - 1000;
    expect(reason(signToken(payload({ iat, exp: iat + 600 })))).toBe("expired");
    expect(reason(signToken(payload({ exp: payload().iat + MAX_CONNECT_LIFETIME_SEC + 1 })))).toBe("malformed");
    expect(reason(signToken(payload()).slice(CONNECT_TOKEN_PREFIX.length))).toBe("malformed");
    expect(reason(`${CONNECT_TOKEN_PREFIX}not.base64url!`)).toBe("malformed");
    expect(reason(signToken({ ...payload(), purpose: "login" as "mcp" }))).toBe("malformed");
  });
});

describe("/mcp/:plane with a connect bearer", () => {
  let t: TestContext;
  let app: FastifyInstance;
  let bare: FastifyInstance;

  const post = (a: FastifyInstance, bearer: string, host: string, plane = McpPlane.Management) => a.inject({
    method: "POST", url: `/mcp/${plane}`,
    headers: { authorization: `Bearer ${bearer}`, host, "content-type": "application/json", accept: "application/json, text/event-stream" },
    payload: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } },
  });
  const parse = (body: string) => {
    if (body.trimStart().startsWith("{")) return JSON.parse(body);
    const data = body.split("\n").filter((l) => l.startsWith("data: ")).at(-1);
    return data ? JSON.parse(data.slice(6)) : {};
  };

  beforeAll(async () => {
    t = await setupTestContext();
    const { db } = createDb(process.env.TEST_DATABASE_URL!);
    const env = { LOG_LEVEL: "error", NODE_ENV: "test", ADMIN_DIST_PATH: undefined, S3_REGION: "us-east-1" } as const;
    app = buildApp({ env: { ...env, ONE_TIME_LOGIN_PUBLIC_KEY: pubPem }, db, services: t.services });
    bare = buildApp({ env, db, services: t.services });
  });
  afterAll(async () => {
    await app.close();
    await bare.close();
    await t.cleanup();
  });

  it("management: initialize succeeds, session id issued, tools/list works with the same bearer", async () => {
    const bearer = signToken(payload());
    const init = await post(app, bearer, HOST);
    expect(init.statusCode).toBe(200);
    expect(parse(init.body).result.serverInfo.name).toBe("prina-management");
    const sid = init.headers["mcp-session-id"] as string;
    expect(sid).toBeTruthy();
    const list = await app.inject({
      method: "POST", url: `/mcp/${McpPlane.Management}`,
      headers: { authorization: `Bearer ${bearer}`, host: HOST, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": sid },
      payload: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    });
    expect(list.statusCode).toBe(200);
    expect(parse(list.body).result.tools.length).toBeGreaterThan(0);
  });

  it("delivery plane token works on /mcp/delivery only", async () => {
    const bearer = signToken(payload({ plane: "delivery" }));
    expect((await post(app, bearer, HOST, McpPlane.Delivery)).statusCode).toBe(200);
    expect((await post(app, bearer, HOST, McpPlane.Management)).statusCode).toBe(401);
  });

  it("wrong host (another tenant), expired, foreign key → 401 with the OAuth hint; no public key → 401", async () => {
    expect((await post(app, signToken(payload()), "other.prina.app")).statusCode).toBe(401);
    const iat = Math.floor(Date.now() / 1000) - 1000;
    expect((await post(app, signToken(payload({ iat, exp: iat + 300 })), HOST)).statusCode).toBe(401);
    const foreign = await post(app, signToken(payload(), otherPriv), HOST);
    expect(foreign.statusCode).toBe(401);
    expect(foreign.headers["www-authenticate"]).toContain("resource_metadata=");
    // Self-hosted shape: no ONE_TIME_LOGIN_PUBLIC_KEY → the surface does not exist
    expect((await post(bare, signToken(payload()), HOST)).statusCode).toBe(401);
  });
});
