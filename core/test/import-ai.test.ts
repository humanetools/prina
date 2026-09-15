/** Phase 7: import, presets, AI (T7.1~T7.3) */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { contentTypeCreate } from "../src/modules/content-type/commands.js";
import {
  importExecute,
  importParse,
  importValidate,
} from "../src/modules/import/commands.js";
import { presetInstall, presetList } from "../src/modules/preset/commands.js";
import { aiSchemaPropose, aiSettingsGet, aiSettingsSet } from "../src/modules/ai/commands.js";
import { createLlmCaller } from "../src/modules/ai/llm.js";
import { getAiSettings } from "../src/modules/ai/routing.js";
import { AppError, ConflictError } from "../src/lib/errors.js";
import { setupTestContext, type TestContext } from "./helpers.js";

function makeXlsxBase64(rows: Record<string, unknown>[]): string {
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }).toString("base64");
}

let t: TestContext;
beforeAll(async () => {
  t = await setupTestContext();
  await contentTypeCreate.run(
    {
      uid: "goods",
      name: "상품",
      definition: {
        displayField: "title",
        fields: [
          { name: "title", type: "text", required: true },
          { name: "price", type: "number", min: 0 },
          { name: "sku", type: "text" },
        ],
      },
    },
    t.ctx,
  );
});
afterAll(async () => t.cleanup());

describe("CSV/Excel import (T7.1)", () => {
  const data = [
    { 상품명: "카메라 A", 가격: 1000, SKU: "A-1" },
    { 상품명: "카메라 B", 가격: "2000", SKU: "B-1" }, // numeric string — to be coerced
    { 상품명: "", 가격: -5, SKU: "C-1" }, // violates price min
  ];
  const mapping = { 상품명: "title", 가격: "price", SKU: "sku" };

  it("parse — returns columns, samples, rows", async () => {
    const parsed = await importParse.run(
      { filename: "goods.xlsx", dataBase64: makeXlsxBase64(data) },
      t.ctx,
    );
    expect(parsed.columns).toEqual(["상품명", "가격", "SKU"]);
    expect(parsed.totalRows).toBe(3);
    expect(parsed.columnSamples["상품명"]).toContain("카메라 A");
  });

  it("validation report — per-row errors (nothing registered)", async () => {
    const report = await importValidate.run(
      { typeUid: "goods", mapping, rows: data },
      t.ctx,
    );
    expect(report.total).toBe(3);
    expect(report.validCount).toBe(2);
    expect(report.errors[0]!.row).toBe(2);
    expect(report.errors[0]!.issues.join()).toMatch(/price/);
  });

  it("execute — coerces numeric strings + per-row results", async () => {
    const result = await importExecute.run(
      { typeUid: "goods", mapping, rows: data },
      t.ctx,
    );
    expect(result.createdCount).toBe(2);
    expect(result.failed).toHaveLength(1);
  });
});

describe("type presets (T7.2)", () => {
  it("4 catalog presets + install=copy (including components)", async () => {
    const presets = await presetList.run({}, t.ctx);
    expect(presets.map((p) => p.id).sort()).toEqual(["article", "event", "faq", "product"]);

    const installed = await presetInstall.run({ presetId: "product" }, t.ctx);
    expect(installed.uid).toBe("product");
    // Reinstalling the same uid → 409
    await expect(
      presetInstall.run({ presetId: "product" }, t.ctx),
    ).rejects.toBeInstanceOf(ConflictError);
    // Copy-install with uidOverride — relation targets follow
    const second = await presetInstall.run(
      { presetId: "product", uidOverride: "product2" },
      t.ctx,
    );
    expect(second.uid).toBe("product2");
  });
});

describe("AI schema generation (T7.3)", () => {
  it("feature disabled when unconfigured (rest works — §2.9)", async () => {
    const status = await aiSettingsGet.run({}, t.ctx);
    expect(status.configured).toBe(false);
    await expect(
      aiSchemaPropose.run({ prompt: "산업용 카메라 상품" }, t.ctx),
    ).rejects.toMatchObject({ code: "AI_NOT_CONFIGURED" });
  });

  it("returns a draft + validation issues — does not create the type (AI stops at drafts)", async () => {
    // Inject an LLM stub (in place of BYOK)
    t.services.llm = async () =>
      JSON.stringify({
        uid: "camera",
        name: "산업용 카메라",
        schemaOrgType: "Product",
        definition: {
          displayField: "title",
          fields: [
            { name: "title", type: "text", label: "모델명", required: true },
            { name: "price", type: "number", label: "가격" },
            { name: "badField", type: "hologram" }, // triggers a validation issue
          ],
        },
      });
    const proposal = await aiSchemaPropose.run(
      { prompt: "산업용 카메라 상품 타입 만들어줘" },
      t.ctx,
    );
    expect(proposal.reviewRequired).toBe(true);
    expect(proposal.draft.uid).toBe("camera");
    expect(proposal.issues.join()).toMatch(/hologram/); // issue shown on the human review screen
    delete t.services.llm;
  });

  it("stores the chosen provider and falls back to its default model (multi-provider BYOK)", async () => {
    await aiSettingsSet.run({ apiKey: "sk-test-openai-key", provider: "openai" }, t.ctx);
    const status = await aiSettingsGet.run({}, t.ctx);
    expect(status.configured).toBe(true);
    expect(status.provider).toBe("openai");
    expect(status.model).toBe("gpt-5.1"); // provider default when model omitted
    // switching provider with an explicit model keeps it
    await aiSettingsSet.run(
      { apiKey: "AIza-test-gemini", provider: "gemini", model: "gemini-2.5-pro" },
      t.ctx,
    );
    const after = await aiSettingsGet.run({}, t.ctx);
    expect(after.provider).toBe("gemini");
    expect(after.model).toBe("gemini-2.5-pro");
    await aiSettingsSet.run({ apiKey: null }, t.ctx); // clear for other tests
  });

  it("keeps the anthropic workspace id for identity-linked keys and sends it as a header", async () => {
    await aiSettingsSet.run(
      { apiKey: "sk-ant-test-identity", provider: "anthropic", anthropicWorkspaceId: "wrkspc_123" },
      t.ctx,
    );
    const settings = (await getAiSettings(t.ctx.db))!;
    expect(settings.anthropicWorkspaceId).toBe("wrkspc_123");
    // pasted console URLs and "wrkspc_…/billing" reduce to the id token (live find 2026-08-31)
    await aiSettingsSet.run(
      {
        apiKey: "sk-ant-test-identity",
        provider: "anthropic",
        anthropicWorkspaceId: "https://console.anthropic.com/settings/workspaces/wrkspc_abc/billing",
      },
      t.ctx,
    );
    expect((await getAiSettings(t.ctx.db))!.anthropicWorkspaceId).toBe("wrkspc_abc");
    // the caller forwards it to api.anthropic.com (identity-linked keys 400 without it)
    const seen: Array<Record<string, string>> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: { headers?: Record<string, string> }) => {
      seen.push(init?.headers ?? {});
      return new Response(JSON.stringify({ content: [{ type: "text", text: "hi" }] }), { status: 200 });
    }) as typeof fetch;
    try {
      await createLlmCaller(settings)({ system: "s", user: "q" });
    } finally { globalThis.fetch = realFetch; }
    expect(seen[0]?.["anthropic-workspace-id"]).toBe("wrkspc_123");
    // saving a model tweak keeps the workspace id; an empty string clears it
    await aiSettingsSet.run({ provider: "anthropic", model: "claude-opus-5" }, t.ctx);
    expect((await getAiSettings(t.ctx.db))!.anthropicWorkspaceId).toBe("wrkspc_abc");
    await aiSettingsSet.run(
      { apiKey: "sk-ant-test-identity", provider: "anthropic", anthropicWorkspaceId: "" },
      t.ctx,
    );
    expect((await getAiSettings(t.ctx.db))!.anthropicWorkspaceId).toBeUndefined();
    await aiSettingsSet.run({ apiKey: null }, t.ctx);
  });
});
