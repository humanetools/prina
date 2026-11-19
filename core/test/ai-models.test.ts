/** 31-IMPL — model lists from the providers: parsing, per-target filters, catalog fallback, errors, stored keys */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createDb } from "../src/db/client.js";
import { eq } from "drizzle-orm";
import { instanceSettings } from "../src/db/schema/index.js";
import { aiModelsList, aiSettingsSet } from "../src/modules/ai/commands.js";
import { listProviderModels, VOYAGE_CATALOG } from "../src/modules/ai/models.js";
import { AppError, NotFoundError, ValidationError } from "../src/lib/errors.js";
import { setupTestContext, type TestContext } from "./helpers.js";

let t: TestContext;
let app: FastifyInstance;
const realFetch = globalThis.fetch;
const seen: Array<{ url: string; headers: Record<string, string> }> = [];

/** fetch stub keyed by URL substring */
function stubFetch(routes: Record<string, (url: string) => Response | Error>) {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    for (const [needle, handler] of Object.entries(routes)) {
      if (url.includes(needle)) {
        const out = handler(url);
        if (out instanceof Error) throw out;
        return out;
      }
    }
    return new Response("no stub", { status: 500 });
  }) as typeof fetch;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeAll(async () => {
  t = await setupTestContext();
  const { db } = createDb(process.env.TEST_DATABASE_URL!);
  app = buildApp({ env: { LOG_LEVEL: "error", NODE_ENV: "test", ADMIN_DIST_PATH: undefined, S3_REGION: "us-east-1" }, db, services: t.services });
});
afterAll(async () => { await app.close(); await t.cleanup(); });
afterEach(async () => {
  globalThis.fetch = realFetch;
  seen.length = 0;
  // only the AI config — the setup-complete flag lives in the same table and the HTTP path gates on it
  await t.ctx.db.delete(instanceSettings).where(eq(instanceSettings.key, "ai"));
});

describe("listProviderModels", () => {
  it("Anthropic: x-api-key + version headers, newest-first order kept, display name in the label", async () => {
    stubFetch({ "api.anthropic.com/v1/models": () => json({ data: [{ id: "claude-opus-5", display_name: "Claude Opus 5" }, { id: "claude-sonnet-5", display_name: "Claude Sonnet 5" }] }) });
    const out = await listProviderModels({ target: "lm", provider: "anthropic", apiKey: "sk-ant-x", anthropicWorkspaceId: "wrkspc_1" });
    expect(out.source).toBe("live");
    expect(out.models.map((m) => m.id)).toEqual(["claude-opus-5", "claude-sonnet-5"]);
    expect(out.models[0]!.label).toBe("Claude Opus 5 (claude-opus-5)");
    expect(seen[0]!.headers).toMatchObject({ "x-api-key": "sk-ant-x", "anthropic-version": "2023-06-01", "anthropic-workspace-id": "wrkspc_1" });
  });

  it("OpenAI: one list for everything — chat keeps chat models, embeddings keeps *embedding* only", async () => {
    const data = ["gpt-5.1", "text-embedding-3-large", "whisper-1", "gpt-5-mini", "dall-e-3", "tts-1", "text-embedding-3-small", "gpt-realtime"].map((id) => ({ id }));
    stubFetch({ "api.openai.com/v1/models": () => json({ data }) });
    expect((await listProviderModels({ target: "lm", provider: "openai", apiKey: "sk" })).models.map((m) => m.id)).toEqual(["gpt-5-mini", "gpt-5.1"]);
    expect((await listProviderModels({ target: "ss", provider: "openai", apiKey: "sk" })).models.map((m) => m.id)).toEqual(["text-embedding-3-large", "text-embedding-3-small"]);
    expect(seen[0]!.headers).toMatchObject({ authorization: "Bearer sk" });
  });

  it("Gemini: key as a query parameter, `models/` prefix stripped, filtered by generateContent / embedContent", async () => {
    const models = [
      { name: "models/gemini-3-flash", displayName: "Gemini 3 Flash", supportedGenerationMethods: ["generateContent", "countTokens"] },
      { name: "models/gemini-3-pro", displayName: "Gemini 3 Pro", supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-embedding-001", displayName: "Gemini Embedding", supportedGenerationMethods: ["embedContent"] },
      { name: "models/imagen-4", displayName: "Imagen", supportedGenerationMethods: ["predict"] },
    ];
    stubFetch({ "generativelanguage.googleapis.com/v1beta/models": () => json({ models }) });
    const lm = await listProviderModels({ target: "lm", provider: "gemini", apiKey: "AIza-x" });
    expect(lm.models.map((m) => m.id)).toEqual(["gemini-3-flash", "gemini-3-pro"]);
    expect(seen[0]!.url).toContain("key=AIza-x");
    expect(seen[0]!.headers).toEqual({});
    // gemini is not an ss provider today, but the parser is ready for it
    expect((await listProviderModels({ target: "ss", provider: "gemini", apiKey: "AIza-x" }).catch((e) => e))).toBeInstanceOf(ValidationError);
  });

  it("Mistral / xAI / Llama use their fixed OpenAI-compatible base; custom needs a base URL and strips /embeddings for ss", async () => {
    stubFetch({
      "api.mistral.ai/v1/models": () => json({ data: [{ id: "mistral-large-latest" }] }),
      "api.x.ai/v1/models": () => json({ data: [{ id: "grok-4" }] }),
      "llm.internal/v1/models": () => json({ data: [{ id: "bge-m3" }, { id: "llama-3.3-70b" }] }),
    });
    expect((await listProviderModels({ target: "lm", provider: "mistral", apiKey: "k" })).models[0]!.id).toBe("mistral-large-latest");
    expect((await listProviderModels({ target: "lm", provider: "xai", apiKey: "k" })).models[0]!.id).toBe("grok-4");
    expect((await listProviderModels({ target: "ss", provider: "custom", apiKey: "k", baseUrl: "https://llm.internal/v1/embeddings" })).models.map((m) => m.id)).toEqual(["bge-m3", "llama-3.3-70b"]);
    expect(seen.at(-1)!.url).toBe("https://llm.internal/v1/models");
    await expect(listProviderModels({ target: "lm", provider: "custom", apiKey: "k" })).rejects.toBeInstanceOf(ValidationError);
  });

  it("Voyage has no list endpoint — the documented catalog, marked as such, without a network call", async () => {
    stubFetch({});
    const out = await listProviderModels({ target: "ss", provider: "voyage", apiKey: "pa-x" });
    expect(out.source).toBe("catalog");
    expect(out.models).toEqual(VOYAGE_CATALOG);
    expect(out.note).toContain("no model-list API");
    expect(seen).toHaveLength(0);
  });

  it("a refused or unreachable provider answers 502 AI_PROVIDER_ERROR with the provider's message", async () => {
    stubFetch({ "api.anthropic.com": () => json({ error: { message: "invalid x-api-key" } }, 401), "api.openai.com": () => new Error("ECONNRESET") });
    const denied = await listProviderModels({ target: "lm", provider: "anthropic", apiKey: "bad" }).catch((e) => e);
    expect(denied).toBeInstanceOf(AppError);
    expect(denied).toMatchObject({ code: "AI_PROVIDER_ERROR", statusCode: 502 });
    expect(denied.message).toContain("invalid x-api-key");
    const down = await listProviderModels({ target: "lm", provider: "openai", apiKey: "k" }).catch((e) => e);
    expect(down).toMatchObject({ code: "AI_PROVIDER_ERROR" });
    expect(down.message).toContain("ECONNRESET");
  });
});

describe("ai_models.list command / route", () => {
  it("entryId uses the stored key and base URL; the key never appears in the response", async () => {
    await aiSettingsSet.run({ lm: { chain: [{ provider: "gemini", apiKey: "AIza-stored-key", model: "gemini-2.5-flash" }] } }, t.ctx);
    stubFetch({ "generativelanguage.googleapis.com": () => json({ models: [{ name: "models/gemini-3-flash", supportedGenerationMethods: ["generateContent"] }] }) });
    const cfg = (await import("../src/modules/ai/routing.js")).readAiConfig;
    const entryId = (await cfg(t.ctx.db)).lm.chain[0]!.id;
    const out = await aiModelsList.run({ target: "lm", entryId }, t.ctx);
    expect(out.models.map((m) => m.id)).toEqual(["gemini-3-flash"]);
    expect(seen[0]!.url).toContain("key=AIza-stored-key");
    expect(JSON.stringify(out)).not.toContain("AIza-stored-key");
    await expect(aiModelsList.run({ target: "lm", entryId: "l-nope" }, t.ctx)).rejects.toBeInstanceOf(NotFoundError);
    await expect(aiModelsList.run({ target: "lm" }, t.ctx)).rejects.toBeInstanceOf(ValidationError);
  });

  it("POST /api/ai/models is session-only — an access token is refused, a session gets the list", async () => {
    stubFetch({ "api.openai.com/v1/models": () => json({ data: [{ id: "gpt-5.1" }] }) });
    const session = await t.createSession();
    const res = await app.inject({ method: "POST", url: "/api/ai/models", headers: { cookie: `prina_session=${session}`, "x-prina-workspace": t.workspaceSlug }, payload: { target: "lm", provider: "openai", apiKey: "sk-test-key" } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().models[0].id).toBe("gpt-5.1");
    const { mcpTokenCreate } = await import("../src/modules/mcp/tokens.js");
    const { ApiGrantItem, ApiGrantLevel, McpPlane } = await import("@prina/shared");
    const token = (await mcpTokenCreate.run({ name: "models-tok", plane: McpPlane.Management, grants: Object.values(ApiGrantItem).map((item) => ({ item, level: ApiGrantLevel.Edit })) }, t.ctx)).token;
    const denied = await app.inject({ method: "POST", url: "/api/ai/models", headers: { authorization: `Bearer ${token}` }, payload: { target: "lm", provider: "openai", apiKey: "sk-test-key" } });
    expect([401, 403]).toContain(denied.statusCode);
  });
});
