/**
 * Rendition proxy (IMPL-saas-cloud §3 ⑥) — /img/* forwards to the internal imgproxy
 * address, and rendition URLs are issued against the public /img base.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createDb } from "../src/db/client.js";
import { createStorageServices } from "../src/storage/index.js";
import { assetConfirmUpload, assetGet, assetRequestUpload } from "../src/modules/asset/commands.js";
import { setupTestContext, type TestContext } from "./helpers.js";

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const RENDITION_PATH = "/abc/rs:fill:1:1/xyz";
const ETAG = '"rendition-v1"';

const s3Env = {
  S3_ENDPOINT: "http://localhost:9000",
  S3_REGION: "us-east-1",
  S3_BUCKET: "prina-assets",
  S3_ACCESS_KEY: "ak",
  S3_SECRET_KEY: "sk",
  IMGPROXY_KEY: "61",
  IMGPROXY_SALT: "62",
  LOCAL_STORAGE_DIR: undefined,
} as const;

let t: TestContext;
let upstream: Server;
let upstreamUrl: string;
let app: FastifyInstance;
/** Method and path of the last request the fake imgproxy saw */
let lastUpstreamRequest: { method?: string; url?: string; headers: Record<string, unknown> };

function startUpstream(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      lastUpstreamRequest = { method: req.method, url: req.url, headers: req.headers };
      if (req.url !== RENDITION_PATH) {
        res.writeHead(403, { "content-type": "text/plain" });
        res.end("Forbidden");
        return;
      }
      if (req.headers["if-none-match"] === ETAG) {
        res.writeHead(304, { etag: ETAG });
        res.end();
        return;
      }
      res.writeHead(200, {
        "content-type": "image/png",
        "content-length": String(TINY_PNG.length),
        etag: ETAG,
      });
      res.end(req.method === "HEAD" ? undefined : TINY_PNG);
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

beforeAll(async () => {
  t = await setupTestContext();
  ({ server: upstream, url: upstreamUrl } = await startUpstream());
  const { db } = createDb(process.env.TEST_DATABASE_URL!);
  // No services injected: the app assembles storage from env, so the S3+imgproxy
  // combination creates the signer and registers /img
  app = buildApp({
    env: {
      LOG_LEVEL: "error",
      NODE_ENV: "test",
      ADMIN_DIST_PATH: undefined,
      ...s3Env,
      IMGPROXY_URL: upstreamUrl,
    },
    db,
  });
});
afterAll(async () => {
  await app.close();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  await t.cleanup();
});

describe("GET|HEAD /img/* proxy", () => {
  it("streams the upstream body with content-type and etag, adding a default cache-control", async () => {
    const res = await app.inject({ method: "GET", url: `/img${RENDITION_PATH}` });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(TINY_PNG)).toBe(true);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers["etag"]).toBe(ETAG);
    expect(res.headers["content-length"]).toBe(String(TINY_PNG.length));
    expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(lastUpstreamRequest.method).toBe("GET");
    expect(lastUpstreamRequest.url).toBe(RENDITION_PATH);
  });

  it("HEAD reaches upstream as HEAD and returns headers without a body", async () => {
    const res = await app.inject({ method: "HEAD", url: `/img${RENDITION_PATH}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.rawPayload.length).toBe(0);
    expect(lastUpstreamRequest.method).toBe("HEAD");
  });

  it("forwards if-none-match and passes the upstream 304 through", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/img${RENDITION_PATH}`,
      headers: { "if-none-match": ETAG },
    });
    expect(res.statusCode).toBe(304);
    expect(res.headers["etag"]).toBe(ETAG);
    expect(res.rawPayload.length).toBe(0);
    expect(lastUpstreamRequest.headers["if-none-match"]).toBe(ETAG);
  });

  it("passes an upstream 403 (bad signature) through unchanged", async () => {
    const res = await app.inject({ method: "GET", url: "/img/bad-sig/rs:fill:1:1/xyz" });
    expect(res.statusCode).toBe(403);
    expect(res.headers["cache-control"]).toBeUndefined();
  });

  it("rejects methods other than GET/HEAD", async () => {
    const res = await app.inject({ method: "POST", url: `/img${RENDITION_PATH}` });
    expect([404, 405]).toContain(res.statusCode);
  });

  it("answers 502 with the error envelope when upstream is down", async () => {
    const { server, url } = await startUpstream();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const { db } = createDb(process.env.TEST_DATABASE_URL!);
    const downApp = buildApp({
      env: {
        LOG_LEVEL: "silent" as "error",
        NODE_ENV: "test",
        ADMIN_DIST_PATH: undefined,
        ...s3Env,
        IMGPROXY_URL: url,
      },
      db,
    });
    try {
      const res = await downApp.inject({ method: "GET", url: `/img${RENDITION_PATH}` });
      expect(res.statusCode).toBe(502);
      expect(res.json()).toEqual({
        error: { code: "UPSTREAM_UNAVAILABLE", message: expect.any(String), details: null },
      });
    } finally {
      await downApp.close();
    }
  });

  it("is not registered when imgproxy is not configured", async () => {
    const res = await app.inject({ method: "GET", url: "/img/x" });
    expect(res.statusCode).not.toBe(404);
    const { db } = createDb(process.env.TEST_DATABASE_URL!);
    const plain = buildApp({
      env: { LOG_LEVEL: "error", NODE_ENV: "test", ADMIN_DIST_PATH: undefined, S3_REGION: "us-east-1" },
      db,
      services: t.services,
    });
    try {
      expect((await plain.inject({ method: "GET", url: "/img/x" })).statusCode).toBe(404);
    } finally {
      await plain.close();
    }
  });
});

describe("rendition URLs use the public base", () => {
  async function detailWith(publicUrl: string | undefined) {
    const { imgproxy } = createStorageServices({
      ...s3Env,
      NODE_ENV: "test",
      IMGPROXY_URL: "http://127.0.0.1:8080",
      IMGPROXY_PUBLIC_URL: publicUrl,
    });
    expect(imgproxy).not.toBeNull();
    // Local adapter for the file itself; only the signer comes from the S3+imgproxy assembly
    const services = { ...t.services, storage: { adapter: t.services.storage.adapter, imgproxy } };
    const ctx = { ...t.ctx, services };
    const { asset } = await assetRequestUpload.run(
      { filename: "photo.png", mime: "image/png", size: TINY_PNG.length, folder: "/" },
      ctx,
    );
    await services.storage.adapter.put(asset.storageKey, TINY_PNG, "image/png");
    await assetConfirmUpload.run({ id: asset.id }, ctx);
    return assetGet.run({ id: asset.id }, ctx);
  }

  it("defaults to the same-origin /img path, never the internal imgproxy address", async () => {
    const detail = await detailWith(undefined);
    const urls = Object.values(detail.renditions!);
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url).toMatch(/^\/img\/[A-Za-z0-9_-]+\/rs:/);
      expect(url).not.toContain("127.0.0.1");
    }
  });

  it("uses IMGPROXY_PUBLIC_URL when set", async () => {
    const detail = await detailWith("https://acme.example.com/img/");
    for (const url of Object.values(detail.renditions!)) {
      expect(url).toMatch(/^https:\/\/acme\.example\.com\/img\/[A-Za-z0-9_-]+\/rs:/);
    }
  });
});
