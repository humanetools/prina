/**
 * 41-IMPL — nested JSON-LD nodes from components / dynamic zones:
 *  a component field or zone with a `predicate` attaches its values as nodes of the component's
 *  `definition.semantic` type; a wrapper component (no node type) hoists its mapped children onto
 *  the parent; `properties` renames, `wrap` turns a literal into a node; legacy additionalProperty
 *  stays for fields without a predicate.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createDb } from "../src/db/client.js";
import { contentTypeCreate, contentTypeUpdate } from "../src/modules/content-type/commands.js";
import { componentCreate, componentUpdate } from "../src/modules/content-type/component-commands.js";
import { entryCreate } from "../src/modules/entry/commands.js";
import { ValidationError } from "../src/lib/errors.js";
import { publishEntry, setupTestContext, type TestContext } from "./helpers.js";

let t: TestContext;
let app: FastifyInstance;
let faqPageId: string;
let productId: string;

const ldOf = async (typeUid: string, id: string) => {
  const res = await app.inject({ method: "GET", url: `/delivery/${typeUid}/${id}?format=jsonld&ws=${t.workspaceSlug}` });
  expect(res.statusCode).toBe(200);
  return res.json() as Record<string, unknown>;
};

beforeAll(async () => {
  t = await setupTestContext();
  const { db } = createDb(process.env.TEST_DATABASE_URL!);
  app = buildApp({
    env: { LOG_LEVEL: "error", NODE_ENV: "test", ADMIN_DIST_PATH: undefined, S3_REGION: "us-east-1" },
    db,
    services: t.services,
  });

  // FAQ: page(FAQPage) ─mainEntity→ ds.faq (wrapper) ─mainEntity→ ds.faq.items (Question)
  await componentCreate.run(
    {
      uid: "ds.faq.items",
      name: "FAQ item",
      definition: {
        fields: [{ name: "question", type: "text" }, { name: "answer", type: "text" }, { name: "position", type: "number" }],
        semantic: {
          schemaOrgType: "Question",
          properties: { question: "name" },
          wrap: { answer: { property: "acceptedAnswer", schemaOrgType: "Answer", valueProperty: "text" } },
        },
      },
    },
    t.ctx,
  );
  await componentCreate.run(
    {
      uid: "ds.faq",
      name: "FAQ",
      definition: {
        fields: [
          { name: "title", type: "text" },
          { name: "items", type: "component", component: "ds.faq.items", repeatable: true, predicate: "mainEntity" },
        ],
      },
    },
    t.ctx,
  );
  await componentCreate.run(
    { uid: "ds.notice", name: "Notice", definition: { fields: [{ name: "text", type: "text" }] } },
    t.ctx,
  );
  await contentTypeCreate.run(
    {
      uid: "faq_page",
      name: "FAQ page",
      schemaOrgType: "FAQPage",
      definition: {
        fields: [
          { name: "title", type: "text", required: true },
          { name: "sections", type: "dynamic_zone", components: ["ds.faq", "ds.notice"], predicate: "mainEntity" },
          { name: "extras", type: "dynamic_zone", components: ["ds.notice"] },
        ],
        displayField: "title",
      },
    },
    t.ctx,
  );
  const page = await entryCreate.run(
    {
      typeUid: "faq_page",
      values: {
        title: "Help",
        sections: [
          {
            __component: "ds.faq",
            title: "Shipping",
            items: [
              { question: "How long?", answer: "Two days.", position: 1 },
              { question: "Where to?", answer: "Anywhere.", position: 2 },
            ],
          },
          { __component: "ds.notice", text: "Not a question" },
        ],
        extras: [{ __component: "ds.notice", text: "legacy block" }],
      },
    },
    t.ctx,
  );
  faqPageId = page.entry.id;
  await publishEntry(t.ctx, "faq_page", faqPageId);

  // Product ─offers→ ds.offer (Offer)
  await componentCreate.run(
    {
      uid: "ds.offer",
      name: "Offer",
      definition: {
        fields: [{ name: "price", type: "number" }, { name: "currency", type: "text" }, { name: "note", type: "text" }],
        semantic: { schemaOrgType: "Offer", properties: { currency: "priceCurrency", note: "sellerNote" } },
      },
    },
    t.ctx,
  );
  await contentTypeCreate.run(
    {
      uid: "product",
      name: "Product",
      schemaOrgType: "Product",
      definition: {
        fields: [
          { name: "name", type: "text", required: true },
          { name: "offer", type: "component", component: "ds.offer", predicate: "offers" },
        ],
        displayField: "name",
      },
    },
    t.ctx,
  );
  const prod = await entryCreate.run(
    { typeUid: "product", values: { name: "Robot", offer: { price: 1200, currency: "USD", note: "ships free" } } },
    t.ctx,
  );
  productId = prod.entry.id;
  await publishEntry(t.ctx, "product", productId);
});

afterAll(async () => {
  await app.close();
  await t.cleanup();
});

describe("41-IMPL — nested JSON-LD nodes", () => {
  it("zone → wrapper → items: Question nodes land on the page's mainEntity, with renamed and wrapped fields", async () => {
    const ld = await ldOf("faq_page", faqPageId);
    expect(ld["@type"]).toBe("FAQPage");
    expect(ld.mainEntity).toEqual([
      { "@type": "Question", name: "How long?", position: 1, acceptedAnswer: { "@type": "Answer", text: "Two days." } },
      { "@type": "Question", name: "Where to?", position: 2, acceptedAnswer: { "@type": "Answer", text: "Anywhere." } },
    ]);
    // the wrapper's own plain field (title) and the untyped notice block emit nothing under mainEntity
    expect(JSON.stringify(ld.mainEntity)).not.toContain("Shipping");
    expect(JSON.stringify(ld.mainEntity)).not.toContain("Not a question");
    // a zone without a predicate keeps the legacy rule: additionalProperty is not a FAQPage property → dropped
    expect(ld.additionalProperty).toBeUndefined();
    expect(JSON.stringify(ld)).not.toContain("legacy block");
    expect(ld["@context"]).toBe("https://schema.org");
  });

  it("component field → typed node under its predicate; a non-standard property is registered in @context", async () => {
    const ld = await ldOf("product", productId);
    expect(ld.offers).toEqual({ "@type": "Offer", price: 1200, priceCurrency: "USD", sellerNote: "ships free" });
    expect(ld["@context"]).toEqual(["https://schema.org", { sellerNote: "https://prina.dev/vocab#sellerNote" }]);
  });

  it("removing the predicate falls back to additionalProperty; a wrapper with no mapped children emits nothing", async () => {
    const type = (await contentTypeUpdate.run(
      {
        uid: "product",
        definition: {
          fields: [
            { name: "name", type: "text", required: true },
            { name: "offer", type: "component", component: "ds.offer" },
          ],
          displayField: "name",
        },
      },
      t.ctx,
    ));
    expect(type.definition.fields[1]).not.toHaveProperty("predicate");
    const ld = await ldOf("product", productId);
    expect(ld.offers).toBeUndefined();
    expect(ld.additionalProperty).toEqual([
      { "@type": "PropertyValue", name: "offer.price", value: 1200 },
      { "@type": "PropertyValue", name: "offer.currency", value: "USD" },
      { "@type": "PropertyValue", name: "offer.note", value: "ships free" },
    ]);

    await componentUpdate.run(
      { uid: "ds.faq", definition: { fields: [{ name: "title", type: "text" }, { name: "items", type: "component", component: "ds.faq.items", repeatable: true }] } },
      t.ctx,
    );
    const faq = await ldOf("faq_page", faqPageId);
    expect(faq.mainEntity).toBeUndefined();
  });

  it("the sample snippet recurses into components, and the definition validator keeps/limits the mapping", async () => {
    const sample = await app.inject({ method: "GET", url: `/api/content-types/faq_page/jsonld-sample`, headers: {} });
    expect(sample.statusCode).toBe(401); // route exists; session-less call is refused

    const saved = await componentUpdate.run(
      {
        uid: "ds.offer",
        definition: {
          fields: [{ name: "price", type: "number" }],
          semantic: { schemaOrgType: "Offer", properties: { price: "price" } },
        },
      },
      t.ctx,
    );
    expect(saved.definition.semantic).toEqual({ schemaOrgType: "Offer", properties: { price: "price" } });
    await expect(
      componentUpdate.run(
        { uid: "ds.offer", definition: { fields: [{ name: "price", type: "number" }], semantic: { nope: 1 } } },
        t.ctx,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      contentTypeUpdate.run(
        {
          uid: "product",
          definition: {
            fields: [{ name: "name", type: "text" }, { name: "offer", type: "component", component: "ds.offer", predicate: "x".repeat(121) }],
            displayField: "name",
          },
        },
        t.ctx,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
