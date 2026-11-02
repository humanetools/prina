/**
 * PRINA_PLANE (split deployment): a delivery instance answers only the public surface —
 * admin/management routes are 404 at the core, the admin UI is not served; the default
 * plane behaves as before.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp, isDeliveryPlanePath } from "../src/app.js";
import { setupTestContext, type TestContext } from "./helpers.js";

let t: TestContext;
let deliveryApp: FastifyInstance;
let allApp: FastifyInstance;

beforeAll(async () => {
  t = await setupTestContext();
  const adminDist = mkdtempSync(path.join(tmpdir(), "prina-admin-dist-"));
  writeFileSync(path.join(adminDist, "index.html"), "<!doctype html><title>Admin</title>");
  const env = { LOG_LEVEL: "error" as const, NODE_ENV: "test" as const, ADMIN_DIST_PATH: adminDist, S3_REGION: "us-east-1" };
  deliveryApp = buildApp({ db: t.ctx.db, env: { ...env, PRINA_PLANE: "delivery" } });
  allApp = buildApp({ db: t.ctx.db, env });
  await Promise.all([deliveryApp.ready(), allApp.ready()]);
});
afterAll(async () => {
  await Promise.all([deliveryApp.close(), allApp.close()]);
  await t.cleanup();
});

describe("PRINA_PLANE=delivery", () => {
  it("serves the public surface and 404s everything else, including the admin UI", async () => {
    const ws = t.workspaceSlug;
    expect((await deliveryApp.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    expect((await deliveryApp.inject({ method: "GET", url: `/delivery/search?q=hello&ws=${ws}` })).statusCode).toBe(200);
    expect((await deliveryApp.inject({ method: "GET", url: `/delivery/graphql/schema?ws=${ws}` })).statusCode).toBe(200);
    expect((await deliveryApp.inject({ method: "GET", url: "/" })).statusCode).toBe(200);
    // management surface: gone, not merely unauthorized
    for (const url of ["/api/content-types", "/api/setup/status", "/openapi.json", "/oauth/register", "/mcp/management", "/admin/", "/admin/index.html"]) {
      const res = await deliveryApp.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(404);
    }
    // the delivery MCP plane stays (token-gated → 401, not 404)
    expect((await deliveryApp.inject({ method: "POST", url: "/mcp/delivery", payload: {} })).statusCode).toBe(401);
  });

  it("the default plane still serves the management surface (auth-gated) and the admin UI", async () => {
    expect((await allApp.inject({ method: "GET", url: "/api/content-types" })).statusCode).toBe(401);
    expect((await allApp.inject({ method: "GET", url: "/api/setup/status" })).statusCode).toBe(200);
    expect((await allApp.inject({ method: "GET", url: "/admin/" })).statusCode).toBe(200);
  });

  it("path matcher: prefixes, query strings, root", () => {
    expect(isDeliveryPlanePath("/delivery/product?ws=default")).toBe(true);
    expect(isDeliveryPlanePath("/mcp/delivery")).toBe(true);
    expect(isDeliveryPlanePath("/mcp/management")).toBe(false);
    expect(isDeliveryPlanePath("/")).toBe(true);
    expect(isDeliveryPlanePath("/api/entries")).toBe(false);
    expect(isDeliveryPlanePath("/admin/")).toBe(false);
  });
});
