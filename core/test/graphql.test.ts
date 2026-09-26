/**
 * GraphQL read plane (18-IMPL A) — schema generated from the workspace's content types; list
 * with where/orderBy/limit/offset, one by id, single types, relation traversal (published
 * targets), media population, drafts hidden unless the delivery draft token is presented,
 * depth guard, read-only.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { contentTypeCreate } from "../src/modules/content-type/commands.js";
import { componentCreate } from "../src/modules/content-type/component-commands.js";
import { entryCreate } from "../src/modules/entry/commands.js";
import { issueDraftToken } from "../src/modules/delivery/token.js";
import { resetGraphqlSchemaCache } from "../src/modules/graphql/execute.js";
import { buildDeliveryTools } from "../src/mcp/tools.js";
import { resolveWorkspace } from "../src/modules/delivery/service.js";
import { publishEntry, setupTestContext, type TestContext } from "./helpers.js";

let t: TestContext;
let app: FastifyInstance;
let brandId: string;
let phoneId: string;
let draftPhoneId: string;

async function gql(query: string, variables?: Record<string, unknown>, extra = "") {
  const res = await app.inject({
    method: "POST",
    url: `/delivery/graphql?ws=${t.workspaceSlug}${extra}`,
    payload: { query, variables },
  });
  return { status: res.statusCode, body: res.json() as { data?: Record<string, unknown>; errors?: Array<{ message: string }> } };
}

beforeAll(async () => {
  t = await setupTestContext();
  resetGraphqlSchemaCache();
  await componentCreate.run(
    { uid: "gq-spec", name: "Spec", definition: { fields: [{ name: "label", type: "text" }, { name: "value", type: "text" }] } },
    t.ctx,
  );
  await contentTypeCreate.run(
    { uid: "gq-brand", name: "Brand", definition: { fields: [{ name: "name", type: "text", required: true }], displayField: "name" } },
    t.ctx,
  );
  await contentTypeCreate.run(
    {
      uid: "gq-phone",
      name: "Phone",
      definition: {
        fields: [
          { name: "name", type: "text", required: true },
          { name: "price", type: "number" },
          { name: "waterproof", type: "boolean" },
          { name: "brand", type: "relation", target: "gq-brand", relationKind: "manyToOne" },
          { name: "specs", type: "component", component: "gq-spec", repeatable: true },
          { name: "meta", type: "json" },
        ],
        displayField: "name",
      },
    },
    t.ctx,
  );
  await contentTypeCreate.run(
    { uid: "gq-site", name: "Site", kind: "single", definition: { fields: [{ name: "title", type: "text" }], displayField: "title" } },
    t.ctx,
  );
  const brand = await entryCreate.run({ typeUid: "gq-brand", values: { name: "Galaxy" } }, t.ctx);
  brandId = brand.entry.id;
  await publishEntry(t.ctx, "gq-brand", brandId);
  const mk = async (values: Record<string, unknown>, publish = true) => {
    const e = await entryCreate.run({ typeUid: "gq-phone", values }, t.ctx);
    if (publish) await publishEntry(t.ctx, "gq-phone", e.entry.id);
    return e.entry.id;
  };
  phoneId = await mk({ name: "S26 Ultra", price: 1890000, waterproof: true, brand: brandId, specs: [{ label: "display", value: "6.9in" }], meta: { colors: 3 } });
  await mk({ name: "Z Fold7", price: 2398000, waterproof: false, brand: brandId });
  await mk({ name: "A17", price: 399000, waterproof: true });
  draftPhoneId = await mk({ name: "Secret Prototype", price: 1 }, false);
  const site = await entryCreate.run({ typeUid: "gq-site", values: { title: "fictor" } }, t.ctx);
  await publishEntry(t.ctx, "gq-site", site.entry.id);

  app = buildApp({
    db: t.ctx.db,
    env: { LOG_LEVEL: "error", NODE_ENV: "test", ADMIN_DIST_PATH: undefined, S3_REGION: "us-east-1" },
  });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await t.cleanup();
});

describe("[18-IMPL A] GraphQL read plane", () => {
  it("publishes an SDL generated from the types (PascalCase types, plural list fields, single types)", async () => {
    const res = await app.inject({ method: "GET", url: `/delivery/graphql/schema?ws=${t.workspaceSlug}` });
    expect(res.statusCode).toBe(200);
    const sdl = res.body;
    expect(sdl).toContain("type GqPhone");
    expect(sdl).toMatch(/gqPhones\(\s*where: GqPhoneWhere/);
    expect(sdl).toContain("gqPhone(id: ID!): GqPhone");
    expect(sdl).toContain("gqSite(locale: String): GqSite");
    expect(sdl).toContain("brand: GqBrand");
    expect(sdl).toContain("specs: [ComponentGqSpec]");
    expect(sdl).toContain("meta: JSON");
    expect(sdl).toContain("input GqPhoneWhere");
    expect(sdl).toContain("price: NumberFilter");
  });

  it("lists published entries with where / orderBy / limit / offset and a total", async () => {
    const { body } = await gql(`{
      gqPhones(where: { waterproof: { eq: true } }, orderBy: [{ field: price, dir: DESC }], limit: 10) {
        total items { id name price waterproof }
      }
    }`);
    expect(body.errors).toBeUndefined();
    const page = body.data!.gqPhones as { total: number; items: Array<{ name: string; price: number }> };
    expect(page.total).toBe(2);
    expect(page.items.map((i) => i.name)).toEqual(["S26 Ultra", "A17"]); // draft prototype excluded, numeric order
    const cheap = await gql(`{ gqPhones(where: { price: { lt: 500000 } }) { total items { name } } }`);
    expect((cheap.body.data!.gqPhones as { items: Array<{ name: string }> }).items.map((i) => i.name)).toEqual(["A17"]);
    const paged = await gql(`{ gqPhones(orderBy: [{ field: name, dir: ASC }], limit: 1, offset: 1) { items { name } } }`);
    expect((paged.body.data!.gqPhones as { items: Array<{ name: string }> }).items.map((i) => i.name)).toEqual(["S26 Ultra"]);
  });

  it("traverses relations to full published targets, components and JSON; one by id; single type", async () => {
    const { body } = await gql(
      `query($id: ID!) { gqPhone(id: $id) { id name brand { id name } specs { component label value } meta publishedAt } gqSite { title } }`,
      { id: phoneId },
    );
    expect(body.errors).toBeUndefined();
    const phone = body.data!.gqPhone as { id: string; brand: { id: string; name: string }; specs: Array<{ component: string; label: string }>; meta: unknown; publishedAt: string };
    expect(phone.id).toBe(phoneId);
    expect(phone.brand).toEqual({ id: brandId, name: "Galaxy" });
    expect(phone.specs[0]).toMatchObject({ component: "gq-spec", label: "display" });
    expect(phone.meta).toEqual({ colors: 3 });
    expect(phone.publishedAt).toMatch(/^\d{4}-/);
    expect((body.data!.gqSite as { title: string }).title).toBe("fictor");
  });

  it("hides drafts by default and shows them with a valid delivery draft token", async () => {
    const hidden = await gql(`query($id: ID!) { gqPhone(id: $id) { name } }`, { id: draftPhoneId });
    expect(hidden.body.data!.gqPhone).toBeNull();
    const { token } = await issueDraftToken(t.ctx.db, t.workspaceSlug, 1);
    const shown = await gql(`query($id: ID!) { gqPhone(id: $id) { name status } }`, { id: draftPhoneId }, `&draft=${encodeURIComponent(token)}`);
    expect(shown.body.data!.gqPhone).toEqual({ name: "Secret Prototype", status: "draft" });
  });

  it("rejects unknown fields, too-deep queries and non-query operations; GET works for simple queries", async () => {
    const bad = await gql(`{ gqPhones { items { nope } } }`);
    expect(bad.body.errors?.[0]?.message).toMatch(/Cannot query field "nope"/);
    const deep = await gql(`{ gqPhones { items { brand { gqPhones { items { brand { name } } } } } } }`);
    expect(deep.body.errors?.length ?? 0).toBeGreaterThan(0);
    const mut = await gql(`mutation { x }`);
    expect(mut.body.errors?.[0]?.message).toMatch(/read-only/);
    const get = await app.inject({ method: "GET", url: `/delivery/graphql?ws=${t.workspaceSlug}&query=${encodeURIComponent("{ gqSite { title } }")}` });
    expect(get.statusCode).toBe(200);
    expect((get.json() as { data: { gqSite: { title: string } } }).data.gqSite.title).toBe("fictor");
  });

  it("[18-IMPL F] MCP delivery plane offers graphql_schema + graphql (not for locale-scoped tokens)", async () => {
    const workspace = await resolveWorkspace(t.ctx.db, t.workspaceSlug);
    const set = await buildDeliveryTools(t.ctx.db, t.ctx.services, workspace, null);
    expect(set.tools.map((x) => x.name)).toEqual(expect.arrayContaining(["graphql_schema", "graphql", "search"]));
    const sdl = (await set.handlers.get("graphql_schema")!({})) as string;
    expect(sdl).toContain("type GqPhone");
    const out = (await set.handlers.get("graphql")!({ query: "{ gqPhones(where: { price: { lt: 500000 } }) { items { name } } }" })) as { data: { gqPhones: { items: Array<{ name: string }> } } };
    expect(out.data.gqPhones.items.map((i) => i.name)).toEqual(["A17"]);
    const scoped = await buildDeliveryTools(t.ctx.db, t.ctx.services, workspace, "ko");
    expect(scoped.tools.map((x) => x.name)).not.toContain("graphql");
  });
});
