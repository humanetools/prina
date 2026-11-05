/** ADMIN_EXTRA_SCRIPTS (2026-11-05): extra <script defer> tags in the served admin index.html */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createDb } from "../src/db/client.js";
import { injectExtraScripts, parseExtraScripts } from "../src/http/admin-extra-scripts.js";
import { setupTestContext, type TestContext } from "./helpers.js";

describe("parseExtraScripts / injectExtraScripts", () => {
  it("keeps https URLs (comma or whitespace separated), drops the rest, dedupes", () => {
    const r = parseExtraScripts(" https://a.example/x.js?k=1&q=2 ,http://b.example/y.js\nhttps://a.example/x.js?k=1&q=2  javascript:alert(1) https://c.example/z.js ");
    expect(r.urls).toEqual(["https://a.example/x.js?k=1&q=2", "https://c.example/z.js"]);
    expect(r.rejected).toEqual(["http://b.example/y.js", "javascript:alert(1)"]);
    expect(parseExtraScripts(undefined)).toEqual({ urls: [], rejected: [] });
    expect(parseExtraScripts("   ")).toEqual({ urls: [], rejected: [] });
  });

  it("inserts escaped defer tags before </head>, leaves the page alone when empty", () => {
    const html = "<html><head><title>x</title></head><body></body></html>";
    expect(injectExtraScripts(html, [])).toBe(html);
    const out = injectExtraScripts(html, ["https://a.example/x.js?k=1&q=2"]);
    expect(out).toBe('<html><head><title>x</title><script defer src="https://a.example/x.js?k=1&amp;q=2"></script>\n</head><body></body></html>');
  });
});

describe("served admin index.html", () => {
  let t: TestContext;
  let dist: string;
  const apps: FastifyInstance[] = [];
  const serve = (extra?: string) => {
    const { db } = createDb(process.env.TEST_DATABASE_URL!);
    const app = buildApp({
      env: { LOG_LEVEL: "error", NODE_ENV: "test", ADMIN_DIST_PATH: dist, ADMIN_EXTRA_SCRIPTS: extra, S3_REGION: "us-east-1" },
      db,
      services: t.services,
    });
    apps.push(app);
    return app;
  };

  beforeAll(async () => {
    t = await setupTestContext();
    dist = mkdtempSync(path.join(os.tmpdir(), "prina-admin-dist-"));
    writeFileSync(path.join(dist, "index.html"), "<!doctype html><html><head><title>Prina</title></head><body><div id=root></div></body></html>");
  });
  afterAll(async () => {
    for (const a of apps) await a.close();
    rmSync(dist, { recursive: true, force: true });
    await t.cleanup();
  });

  it("adds the scripts on /admin/ and SPA fallbacks", async () => {
    const app = serve("https://project.example/embed/memo.js?api=https://api.example&key=abc");
    for (const url of ["/admin/", "/admin/content/page"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('<script defer src="https://project.example/embed/memo.js?api=https://api.example&amp;key=abc"></script>');
    }
  });

  it("serves the page untouched when the env is empty", async () => {
    const res = await serve(undefined).inject({ method: "GET", url: "/admin/" });
    expect(res.body).not.toContain("<script defer");
  });
});
