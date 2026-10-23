/** OpenAPI document vs the real route table and the real access rules (21-IMPL-openapi-completion) */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createDb } from "../src/db/client.js";
import { setupTestContext, type TestContext } from "./helpers.js";
import { articleDefinition } from "./fixtures.js";
import { contentTypeCreate } from "../src/modules/content-type/commands.js";
import { requiredGrantFor } from "../src/http/api-grants.js";
import { requiredScopeFor } from "../src/http/api-scopes.js";
import { API_OPS, openApiPath } from "../src/http/openapi/build.js";
import { mcpTokenCreate } from "../src/modules/mcp/tokens.js";
import { McpPlane, type ApiGrant } from "@prina/shared";

let t: TestContext;
let app: FastifyInstance;
let doc: { paths: Record<string, Record<string, Record<string, unknown>>>; components: Record<string, Record<string, unknown>> };

const HTTP = ["get", "post", "put", "patch", "delete"];

beforeAll(async () => {
  t = await setupTestContext();
  const { db } = createDb(process.env.TEST_DATABASE_URL!);
  app = buildApp({
    env: { LOG_LEVEL: "error", NODE_ENV: "test", ADMIN_DIST_PATH: undefined, S3_REGION: "us-east-1" },
    db,
    services: t.services,
  });
  await app.ready();
  await contentTypeCreate.run({ uid: "article", name: "Article", kind: "collection", definition: articleDefinition }, t.ctx);
  const res = await app.inject({
    method: "GET",
    url: "/openapi.json",
    headers: { "x-prina-workspace": t.workspaceSlug, "x-prina-actor": `human:${t.userId}` },
  });
  expect(res.statusCode).toBe(200);
  doc = res.json();
});
afterAll(async () => {
  await app.close();
  await t.cleanup();
});

describe("OpenAPI — management plane completeness", () => {
  it("every token-reachable route is in the document", () => {
    const missing = app.routeTable
      .filter((r) => HTTP.includes(r.method.toLowerCase()))
      .filter((r) => requiredGrantFor(r.method, r.url.replace(/:[A-Za-z]+/g, "x")) !== null)
      .filter((r) => !doc.paths[openApiPath(r.url)]?.[r.method.toLowerCase()])
      .map((r) => `${r.method} ${r.url}`);
    expect(missing).toEqual([]);
  });

  it("every declaration names a registered route or an edition/adapter-dependent one", () => {
    const OPTIONAL = ["/api/content/:typeUid/:id/versions", "/api/assets/local-upload", "/api/assets/raw/:key"];
    const registered = new Set(app.routeTable.map((r) => `${r.method} ${r.url}`));
    const stale = API_OPS.filter((d) => !registered.has(`${d.method} ${d.path}`) && !OPTIONAL.some((p) => d.path.startsWith(p))).map(
      (d) => `${d.method} ${d.path}`,
    );
    expect(stale).toEqual([]);
  });

  it("every /api operation carries token security and the access the hook would ask for", () => {
    const problems: string[] = [];
    for (const [path, item] of Object.entries(doc.paths)) {
      if (!path.startsWith("/api/")) continue;
      for (const method of HTTP) {
        const op = item[method];
        if (!op) continue;
        const url = path.replace(/\{[A-Za-z]+\}/g, "x");
        const grant = requiredGrantFor(method, url);
        const scope = requiredScopeFor(method, url);
        const access = op["x-prina-access"] as { grant: { item: string; level: string } | null; scope: { resource: string; level: string } | null };
        if (!Array.isArray(op.security) || !JSON.stringify(op.security).includes("managementToken")) problems.push(`${method} ${path}: security`);
        if (access?.grant?.item !== grant?.item || access?.grant?.level !== grant?.level) problems.push(`${method} ${path}: grant`);
        if ((access?.scope?.resource ?? null) !== (scope?.scope ?? null) || (access?.scope?.level ?? null) !== (scope?.level ?? null)) problems.push(`${method} ${path}: scope`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("request shapes come from the commands: bodies, list query, path params, shared errors", () => {
    const list = doc.paths["/api/content/{typeUid}"]!.get!;
    const names = (list.parameters as Array<{ name: string; in: string }>).map((p) => `${p.in}:${p.name}`);
    expect(names).toEqual(expect.arrayContaining(["path:typeUid", "query:locale", "query:status", "query:search", "query:page", "query:pageSize", "query:filter[field]"]));
    expect(names).not.toContain("query:typeUid");

    // per-type copy binds the type and points `values` at the type's schema
    const create = doc.paths["/api/content/article"]!.post!;
    const body = (create.requestBody as { content: Record<string, { schema: { properties: Record<string, unknown> } }> }).content["application/json"]!.schema;
    expect(body.properties.values).toEqual({ $ref: "#/components/schemas/article_values" });
    expect(body.properties.typeUid).toBeUndefined();

    // opaque `definition` is documented from the field registry
    const ctCreate = doc.paths["/api/content-types"]!.post!;
    const ctBody = (ctCreate.requestBody as { content: Record<string, { schema: { properties: Record<string, unknown>; required: string[] } }> }).content["application/json"]!.schema;
    expect(ctBody.properties.definition).toEqual({ $ref: "#/components/schemas/definition" });
    expect(ctBody.required).toEqual(expect.arrayContaining(["uid", "name", "definition"]));
    const variants = (doc.components.schemas!.field_definition as { oneOf: Array<{ title: string }> }).oneOf.map((v) => v.title);
    expect(variants).toEqual(expect.arrayContaining(["text", "relation", "component", "media"]));

    expect((create.responses as Record<string, unknown>)["403"]).toEqual({ $ref: "#/components/responses/Forbidden" });
    expect(doc.components.responses!.Forbidden).toBeDefined();
    expect(JSON.stringify(doc)).not.toContain("x-prina-scope");
  });

  it("an integrator who only reads the document can issue the right token and make the call", async () => {
    const op = doc.paths["/api/locales"]!.post!;
    const need = (op["x-prina-access"] as { grant: { item: string; level: string } }).grant;
    const schema = (op.requestBody as { content: Record<string, { schema: { required: string[]; properties: Record<string, { pattern?: string }> } }> }).content["application/json"]!.schema;
    expect(schema.required).toEqual(["code", "name"]);
    const payload = { code: "zz", name: "Spec-made" };
    expect(new RegExp(schema.properties.code!.pattern!).test(payload.code)).toBe(true);

    const issue = async (name: string, grants: ApiGrant[]) =>
      (await mcpTokenCreate.run({ name, plane: McpPlane.Management, grants }, t.ctx)).token;
    const call = (token: string) =>
      app.inject({ method: "POST", url: "/api/locales", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, payload });

    // one level short of what the document asks for → SCOPE_DENIED, and the details echo x-prina-access
    const short = await call(await issue("spec-read", [{ item: need.item, level: "read" } as ApiGrant]));
    expect(short.statusCode).toBe(403);
    expect(short.json().error).toMatchObject({ code: "SCOPE_DENIED", details: { item: need.item, required: need.level } });

    // exactly what the document asks for → created
    const ok = await call(await issue("spec-exact", [{ item: need.item, level: need.level } as ApiGrant]));
    expect(ok.statusCode).toBe(201);
    expect(ok.json().code).toBe("zz");
  });
});
