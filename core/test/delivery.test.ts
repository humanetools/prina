/** Phase 5: templates, 3-mode serving, GA4 (T5.1~T5.5) */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { DefaultRole, EntryStatus } from "@prina/shared";
import { buildApp } from "../src/app.js";
import { createDb } from "../src/db/client.js";
import { contentTypeCreate } from "../src/modules/content-type/commands.js";
import { entryCreate } from "../src/modules/entry/commands.js";
import {
  templateGet,
  templateSave,
  templateRenderPreview,
} from "../src/modules/template/commands.js";
import { workspaceUpdateSettings } from "../src/modules/workspace/commands.js";
import { issueDraftToken } from "../src/modules/delivery/token.js";
import { populateValuesList } from "../src/modules/delivery/populate.js";
import type { DeliveryCtx } from "../src/modules/delivery/service.js";
import { scopeCss } from "../src/delivery/css-scope.js";
import { buildGaPayloads, resolveMarket, validateGa4Config } from "../src/delivery/ga4.js";
import { ForbiddenError, ValidationError } from "../src/lib/errors.js";
import { publishEntry,
  setupTestContext, type TestContext } from "./helpers.js";

let t: TestContext;
let app: FastifyInstance;
let publishedId: string;
let draftId: string;

const PRODUCT_DEF = {
  fields: [
    { name: "title", type: "text", required: true },
    { name: "price", type: "number" },
    { name: "sku", type: "text" },
  ],
  displayField: "title",
};
const LIQUID = `<h2 class="title">{{ values.title }}</h2><p class="price">{{ values.price | won }}</p><button data-ga-event="add_to_cart">담기</button>`;
const CSS = `.title { color: red; } .price, .badge { font-weight: bold; } @media (min-width: 600px) { .title { font-size: 2rem; } }`;

beforeAll(async () => {
  t = await setupTestContext();
  const { db } = createDb(process.env.TEST_DATABASE_URL!);
  app = buildApp({
    env: { LOG_LEVEL: "error", NODE_ENV: "test", ADMIN_DIST_PATH: undefined, S3_REGION: "us-east-1" },
    db,
    services: t.services,
  });
  await workspaceUpdateSettings.run({ settings: { currency: "KRW" } }, t.ctx);
  await contentTypeCreate.run(
    { uid: "product", name: "상품", definition: PRODUCT_DEF },
    t.ctx,
  );
  const pub = await entryCreate.run(
    { typeUid: "product", values: { title: "발행 상품", price: 15000, sku: "SKU-1" } },
    t.ctx,
  );
  publishedId = pub.entry.id;
  await publishEntry(t.ctx, "product", publishedId);
  const draft = await entryCreate.run(
    { typeUid: "product", values: { title: "초안 상품", price: 900 } },
    t.ctx,
  );
  draftId = draft.entry.id;
});
afterAll(async () => {
  await app.close();
  await t.cleanup();
});

describe("automatic CSS scoping (T5.2)", () => {
  it(".price → .hub-product .price, handles commas and @media", () => {
    const scoped = scopeCss(CSS, ".hub-product");
    expect(scoped).toContain(".hub-product .title { color: red; }");
    expect(scoped).toContain(".hub-product .price, .hub-product .badge");
    expect(scoped).toMatch(/@media \(min-width: 600px\) \{\s*\.hub-product \.title/);
  });
  it("replaces :root/body with the scope root", () => {
    expect(scopeCss(":root { --x: 1; }", ".hub-a")).toContain(".hub-a { --x: 1; }");
  });
});

/** Match failure reasons from ValidationError.details.issues */
function issuesOf(fn: () => unknown): string {
  try {
    fn();
    return "";
  } catch (e) {
    if (e instanceof ValidationError) {
      return JSON.stringify((e.details as { issues?: string[] })?.issues ?? []);
    }
    throw e;
  }
}

describe("GA4 config validation (T5.4 — required parameters enforced)", () => {
  it("ecommerce event with value/item_id unmapped → save rejected", () => {
    expect(() =>
      validateGa4Config({ events: [{ event: "view_item", params: {} }] }, "KRW"),
    ).toThrow(ValidationError);
  });
  it("purchase with transaction_id unmapped → save rejected", () => {
    expect(
      issuesOf(() =>
        validateGa4Config(
          {
            itemMapping: { item_id: "sku" },
            valueField: "price",
            events: [{ event: "purchase", params: {} }],
          },
          "KRW",
        ),
      ),
    ).toMatch(/transaction_id/);
  });
  it("no global currency default and none specified → rejected", () => {
    expect(
      issuesOf(() =>
        validateGa4Config(
          {
            itemMapping: { item_id: "sku" },
            valueField: "price",
            events: [{ event: "view_item", params: {} }],
          },
          undefined,
        ),
      ),
    ).toMatch(/currency/);
  });
  it("valid config passes", () => {
    const cfg = validateGa4Config(
      {
        itemMapping: { item_id: "sku", item_name: "title", price: "price" },
        valueField: "price",
        events: [
          { event: "view_item", params: {} },
          { event: "add_to_cart", params: {} },
        ],
      },
      "KRW",
    );
    expect(cfg.events).toHaveLength(2);
  });

  it("accepts the full official item parameter set and checkout-funnel events", () => {
    const cfg = validateGa4Config(
      {
        itemMapping: {
          item_id: "sku",
          item_category: "cat1",
          item_category2: "cat2",
          item_category3: "cat3",
          item_category4: "cat4",
          item_category5: "cat5",
          item_variant: "color",
          quantity: "qty",
          discount: "discount",
        },
        valueField: "price",
        events: [
          { event: "remove_from_cart", params: {} },
          { event: "add_shipping_info", params: { shipping_tier: "Ground" } },
          { event: "add_payment_info", params: { payment_type: "card" } },
          { event: "refund", params: { transaction_id: "order_no" } },
        ],
      },
      "KRW",
    );
    expect(cfg.events).toHaveLength(4);
    // numeric params coerce mapped text fields (official spec types them as numbers)
    const payloads = buildGaPayloads(
      cfg,
      { sku: "A-1", cat1: "TV", cat5: "OLED", qty: "2", discount: "1000", price: 5000, color: "black", order_no: "T-77" },
      "KRW",
    );
    const rm = payloads.click.remove_from_cart!.ecommerce as { items: Array<Record<string, unknown>> };
    expect(rm.items[0]).toMatchObject({
      item_id: "A-1",
      item_category: "TV",
      item_category5: "OLED",
      item_variant: "black",
      quantity: 2,
      discount: 1000,
    });
    // event params live INSIDE the ecommerce object (GTM dataLayer spec), substituted from fields
    expect(payloads.click.add_shipping_info!.ecommerce).toMatchObject({ shipping_tier: "Ground" });
    expect(payloads.click.refund!.ecommerce).toMatchObject({ transaction_id: "T-77" });
  });

  it("refund without transaction_id is rejected (official spec)", () => {
    expect(
      issuesOf(() =>
        validateGa4Config(
          {
            itemMapping: { item_id: "sku" },
            valueField: "price",
            events: [{ event: "refund", params: {} }],
          },
          "KRW",
        ),
      ),
    ).toMatch(/transaction_id/);
  });

  it("list events need item_id but not currency/value; payload carries no value", () => {
    const cfg = validateGa4Config(
      {
        itemMapping: { item_id: "sku", item_list_name: "list_name" },
        events: [{ event: "view_item_list", params: {} }, { event: "select_item", params: {} }],
      },
      undefined, // no currency anywhere — still valid for list-only configs
    );
    const payloads = buildGaPayloads(cfg, { sku: "A-1", list_name: "Related" }, undefined);
    expect(payloads.view).toHaveLength(1);
    const eco = payloads.view![0]!.ecommerce as Record<string, unknown>;
    expect(eco.value).toBeUndefined();
    expect((eco.items as Array<Record<string, unknown>>)[0]).toMatchObject({
      item_id: "A-1",
      item_list_name: "Related",
    });
  });

  it("promotion events need promotion_id/name; multiple view events stack", () => {
    expect(
      issuesOf(() =>
        validateGa4Config(
          {
            itemMapping: { item_id: "sku" },
            events: [{ event: "view_promotion", params: {} }],
          },
          "KRW",
        ),
      ),
    ).toMatch(/promotion/);

    const cfg = validateGa4Config(
      {
        itemMapping: { item_id: "sku", promotion_name: "title", price: "price" },
        valueField: "price",
        events: [
          { event: "view_item", params: {} },
          { event: "view_promotion", params: { creative_slot: "hero" } },
          { event: "select_promotion", params: {} },
        ],
      },
      "KRW",
    );
    const payloads = buildGaPayloads(cfg, { sku: "A-1", title: "Big Sale", price: 100 }, "KRW");
    expect(payloads.view).toHaveLength(2); // view_item + view_promotion
    const promo = payloads.view![1]!.ecommerce as Record<string, unknown>;
    expect(promo.creative_slot).toBe("hero");
    expect((promo.items as Array<Record<string, unknown>>)[0]).toMatchObject({
      promotion_name: "Big Sale",
    });
    expect(payloads.click.select_promotion).toBeDefined();
  });

  it("per-event itemMapping wins over the top-level fallback", () => {
    const cfg = validateGa4Config(
      {
        // legacy top-level mapping — still honoured by events that do not carry their own
        itemMapping: { item_id: "sku", item_name: "title" },
        valueField: "price",
        events: [
          { event: "view_item", params: {} },
          {
            event: "purchase",
            params: { transaction_id: "order_no" },
            itemMapping: { item_id: "sku", quantity: "qty", coupon: "promo" },
            valueField: "total",
          },
        ],
      },
      "KRW",
    );
    const p = buildGaPayloads(
      cfg,
      { sku: "A-1", title: "Phone", price: 100, qty: "3", promo: "SUMMER", order_no: "T-9", total: 300 },
      "KRW",
    );
    const view = (p.view![0]!.ecommerce as { items: Array<Record<string, unknown>>; value: number });
    expect(view.items[0]).toEqual({ item_id: "A-1", item_name: "Phone" }); // inherited
    expect(view.value).toBe(100);
    const buy = (p.click.purchase!.ecommerce as { items: Array<Record<string, unknown>>; value: number });
    expect(buy.items[0]).toEqual({ item_id: "A-1", quantity: 3, coupon: "SUMMER" }); // own
    expect(buy.value).toBe(300);
  });

  it("a per-event mapping missing item_id is rejected even if the fallback has one", () => {
    expect(
      issuesOf(() =>
        validateGa4Config(
          {
            itemMapping: { item_id: "sku" },
            valueField: "price",
            events: [{ event: "view_item", params: {}, itemMapping: { item_name: "title" } }],
          },
          "KRW",
        ),
      ),
    ).toMatch(/view_item: needs an item_id/);
  });

  it("lead funnel events pass with no ecommerce object", () => {
    const cfg = validateGa4Config(
      {
        events: [
          { event: "generate_lead", params: { lead_source: "web" } },
          { event: "qualify_lead", params: {} },
          { event: "close_convert_lead", params: {} },
        ],
      },
      "KRW",
    );
    const payloads = buildGaPayloads(cfg, {}, "KRW");
    expect(payloads.click.generate_lead).toMatchObject({ lead_source: "web", currency: "KRW" });
    expect(payloads.click.generate_lead!.ecommerce).toBeUndefined();
    expect(payloads.click.qualify_lead).toBeDefined();
  });
});

describe("GA4 markets — per-country currency and GTM container", () => {
  const settings = {
    currency: "KRW",
    ga4Markets: {
      us: { currency: "USD", containerId: "GTM-US1" },
      ko: { currency: "KRW", containerId: "GTM-KR1" },
      de: { currency: "EUR" },
    },
  };
  it("?market= wins, then the entry locale, then the workspace default", () => {
    expect(resolveMarket(settings, "us", "ko")).toMatchObject({ market: "us", currency: "USD", containerId: "GTM-US1" });
    expect(resolveMarket(settings, undefined, "ko")).toMatchObject({ market: "ko", currency: "KRW" });
    expect(resolveMarket(settings, undefined, "ja")).toMatchObject({ market: null, currency: "KRW" });
    expect(resolveMarket(settings, "de", undefined).containerId).toBeUndefined();
  });
  it("single-market installs are unaffected (no ga4Markets)", () => {
    expect(resolveMarket({ currency: "KRW" }, "us", "ko")).toMatchObject({ market: null, currency: "KRW" });
  });
  it("payload currency follows the resolved market", () => {
    const cfg = validateGa4Config(
      { itemMapping: { item_id: "sku" }, valueField: "price", events: [{ event: "view_item", params: {} }] },
      "KRW",
    );
    const usd = buildGaPayloads(cfg, { sku: "A", price: 10 }, resolveMarket(settings, "us", "ko").currency);
    expect((usd.view![0]!.ecommerce as { currency: string }).currency).toBe("USD");
    const krw = buildGaPayloads(cfg, { sku: "A", price: 10 }, resolveMarket(settings, undefined, "ko").currency);
    expect((krw.view![0]!.ecommerce as { currency: string }).currency).toBe("KRW");
  });
});

describe("template save/versioning (T5.1/T5.3)", () => {
  it("save = new version, script.js is developer-only (DoD)", async () => {
    const v1 = await templateSave.run(
      {
        typeUid: "product",
        liquid: LIQUID,
        css: CSS,
        js: "console.log('v1');",
        events: {
          itemMapping: { item_id: "sku", item_name: "title", price: "price" },
          valueField: "price",
          events: [
            { event: "view_item", params: {} },
            { event: "add_to_cart", params: {} },
          ],
        },
      },
      t.ctx,
    );
    expect(v1.version).toBe(1);

    // editor: can save liquid/css (js not passed — previous js kept)
    const { ctx: editorCtx } = await t.createUserCtx([DefaultRole.Editor]);
    const v2 = await templateSave.run(
      { typeUid: "product", liquid: LIQUID + "<!-- v2 -->", css: CSS },
      editorCtx,
    );
    expect(v2.version).toBe(2);
    expect(v2.js).toBe("console.log('v1');"); // kept

    // editor: attempting to change js → 403 (T2.2/T5.3 DoD: 403 on script.js save attempt)
    await expect(
      templateSave.run(
        { typeUid: "product", liquid: LIQUID, css: CSS, js: "alert('hack')" },
        editorCtx,
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);

    const got = await templateGet.run({ typeUid: "product" }, editorCtx);
    expect(got.current?.version).toBe(2);
    expect(got.canEditScript).toBe(false);
    expect(got.versions).toHaveLength(2);
  });

  it("preview render — draft entry + won filter (T5.5)", async () => {
    const preview = await templateRenderPreview.run(
      { typeUid: "product", entryId: draftId },
      t.ctx,
    );
    expect(preview.html).toContain("초안 상품");
    expect(preview.html).toContain("₩900");
  });
});

describe("3-mode serving (T5.2 DoD)", () => {
  it("mode 1 JSON — published only, draft returns 404", async () => {
    const ok = await app.inject({
      method: "GET",
      url: `/delivery/product/${publishedId}?ws=${t.workspaceSlug}`,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().values.title).toBe("발행 상품");
    expect(ok.headers["cache-control"]).toContain("public");

    const draft = await app.inject({
      method: "GET",
      url: `/delivery/product/${draftId}?ws=${t.workspaceSlug}`,
    });
    expect(draft.statusCode).toBe(404);
  });

  // A malformed id used to reach Postgres and come back as a 500 (2026-08-24)
  it("a non-uuid id is a 400, not a 500", async () => {
    const entry = await app.inject({
      method: "GET",
      url: `/delivery/product/not-a-uuid?ws=${t.workspaceSlug}`,
    });
    expect(entry.statusCode).toBe(400);
    expect(entry.json().error.code).toBe("VALIDATION_ERROR");

    const asset = await app.inject({
      method: "GET",
      url: `/delivery/assets/not-a-uuid?ws=${t.workspaceSlug}`,
    });
    expect(asset.statusCode).toBe(400);

    // A well-formed id that simply does not exist stays a 404
    const missing = await app.inject({
      method: "GET",
      url: `/delivery/product/00000000-0000-0000-0000-000000000000?ws=${t.workspaceSlug}`,
    });
    expect(missing.statusCode).toBe(404);
  });

  // parseVersion handed NaN (vXX) and 1e21 (overflow) straight to a Postgres int compare
  it("a garbage template version tag is a 404, not a 500", async () => {
    for (const tag of ["vXX", "v999999999999999999999", "v0"]) {
      const res = await app.inject({
        method: "GET",
        url: `/delivery/templates/product/${tag}/style.css?ws=${t.workspaceSlug}`,
      });
      expect(res.statusCode, tag).toBe(404);
    }
  });

  it("draft token grants draft access + no-store (T5.5)", async () => {
    const { token } = await issueDraftToken(t.db, t.workspaceSlug, 1);
    const res = await app.inject({
      method: "GET",
      url: `/delivery/product/${draftId}?ws=${t.workspaceSlug}&draft=${token}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().values.title).toBe("초안 상품");
    expect(res.headers["cache-control"]).toContain("no-store");
    // Token from another workspace is invalid
    const bad = await app.inject({
      method: "GET",
      url: `/delivery/product/${draftId}?ws=${t.workspaceSlug}&draft=dt1.other.9999999999.x`,
    });
    expect(bad.statusCode).toBe(404);
  });

  it("mode 2 HTML fragment — includes scope class, versioned CSS URL, GA runtime", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/delivery/product/${publishedId}?format=html&ws=${t.workspaceSlug}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    const html = res.body;
    expect(html).toContain('class="hub-product"');
    expect(html).toContain("/delivery/templates/product/v2/style.css");
    expect(html).toContain("발행 상품");
    expect(html).toContain("₩15,000");
    expect(html).toContain("prina-ga-config");
    expect(html).toContain("dataLayer");

    // Versioned CSS is scoped and served with immutable caching (T5.2)
    const css = await app.inject({
      method: "GET",
      url: `/delivery/templates/product/v2/style.css?ws=${t.workspaceSlug}`,
    });
    expect(css.statusCode).toBe(200);
    expect(css.body).toContain(".hub-product .title");
    expect(css.headers["cache-control"]).toContain("immutable");
  });

  it("mode 3 embed — serves embed.js + GA included in JSON payload", async () => {
    const script = await app.inject({ method: "GET", url: "/delivery/embed.js" });
    expect(script.statusCode).toBe(200);
    expect(script.body).toContain("attachShadow");
    expect(script.body).toContain("window.dataLayer");

    const res = await app.inject({
      method: "GET",
      url: `/delivery/product/${publishedId}?format=html&embed=1&ws=${t.workspaceSlug}`,
    });
    const data = res.json();
    expect(data.html).toContain("발행 상품");
    expect(data.css).toContain(".title");
    // GA payload: view_item automatic + add_to_cart on click (T5.4); view is an array
    expect(data.ga.view[0].event).toBe("view_item");
    expect(data.ga.view[0].ecommerce).toMatchObject({
      currency: "KRW",
      value: 15000,
      items: [{ item_id: "SKU-1", item_name: "발행 상품", price: 15000 }],
    });
    expect(data.ga.click.add_to_cart.event).toBe("add_to_cart");
  });
});

describe("delivery populate (?populate=1)", () => {
  it("relations resolve to summaries of published targets, draft targets excluded", async () => {
    await contentTypeCreate.run(
      {
        uid: "writer",
        name: "작가",
        schemaOrgType: "Person",
        definition: { fields: [{ name: "name", type: "text", required: true }], displayField: "name" },
      },
      t.ctx,
    );
    await contentTypeCreate.run(
      {
        uid: "column",
        name: "칼럼",
        schemaOrgType: "Article",
        definition: {
          fields: [
            { name: "title", type: "text", required: true },
            { name: "author", type: "relation", target: "writer", relationKind: "manyToOne", predicate: "writtenBy", inversePredicate: "authorOf", writeInverse: true },
            { name: "coauthors", type: "relation", target: "writer", relationKind: "manyToMany" },
          ],
          displayField: "title",
        },
      },
      t.ctx,
    );
    const w1 = await entryCreate.run({ typeUid: "writer", values: { name: "김작가" } }, t.ctx);
    const w2 = await entryCreate.run({ typeUid: "writer", values: { name: "이초안" } }, t.ctx);
    // Publish only w1, leave w2 as draft
    await publishEntry(t.ctx, "writer", w1.entry.id);
    const col = await entryCreate.run(
      {
        typeUid: "column",
        values: { title: "칼럼1", author: w1.entry.id, coauthors: [w1.entry.id, w2.entry.id] },
      },
      t.ctx,
    );

    const dctx: DeliveryCtx = {
      db: t.db,
      services: t.ctx.services,
      workspace: { id: t.ctx.workspaceId, slug: "default", settings: {} },
      includeDraft: false,
    };
    const colType = { fields: [
      { name: "title", type: "text" },
      { name: "author", type: "relation", target: "writer", relationKind: "manyToOne" },
      { name: "coauthors", type: "relation", target: "writer", relationKind: "manyToMany" },
    ] };
    const [populated] = await populateValuesList(
      dctx,
      colType as never,
      [col.entry.values as Record<string, unknown>],
    );
    // Singular relation → summary object
    expect(populated!.author).toMatchObject({ id: w1.entry.id, display: "김작가" });
    // Plural relation → only published remain (draft w2 excluded)
    expect(populated!.coauthors).toEqual([
      expect.objectContaining({ id: w1.entry.id, display: "김작가" }),
    ]);
    // Plain values pass through unchanged
    expect(populated!.title).toBe("칼럼1");

    // ── T9.1 JSON-LD ──
    await publishEntry(t.ctx, "column", col.entry.id);
    const ldRes = await app.inject({
      method: "GET",
      url: `/delivery/column/${col.entry.id}?format=jsonld&ws=${t.workspaceSlug}`,
    });
    expect(ldRes.statusCode).toBe(200);
    expect(ldRes.headers["content-type"]).toContain("application/ld+json");
    const ld = ldRes.json();
    // Custom predicate (writtenBy) is registered in @context under the prina vocab
    expect(ld["@context"]).toEqual([
      "https://schema.org",
      { writtenBy: "https://prina.dev/vocab#writtenBy" },
    ]);
    expect(ld["@type"]).toBe("Article");
    expect(ld.name).toBe("칼럼1");
    expect(ld.identifier).toBe(col.entry.id);
    // Predicate becomes the property name + target becomes a schemaOrgType/Person node
    expect(ld.writtenBy).toMatchObject({ "@type": "Person", identifier: w1.entry.id, name: "김작가" });
    // Relation without a predicate (coauthors) is not a schema.org property of Article, so it is dropped
    expect(ld.coauthors).toBeUndefined();

    // ── inverse: authorOf is emitted in reverse on writer(w1)'s JSON-LD ──
    const wRes = await app.inject({
      method: "GET",
      url: `/delivery/writer/${w1.entry.id}?format=jsonld&ws=${t.workspaceSlug}`,
    });
    expect(wRes.statusCode).toBe(200);
    const wld = wRes.json();
    expect(wld["@type"]).toBe("Person");
    expect(wld.authorOf).toEqual([
      expect.objectContaining({ "@type": "Article", identifier: col.entry.id, name: "칼럼1" }),
    ]);
    // Custom inverse predicate is also registered in @context
    expect(wld["@context"]).toEqual([
      "https://schema.org",
      { authorOf: "https://prina.dev/vocab#authorOf" },
    ]);
  });
});
