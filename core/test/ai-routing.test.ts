/** 11-IMPL — AI provider routing: v1 upgrade, chain merge, failover, health, ss switch */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { instanceSettings } from "../src/db/schema/index.js";
import { aiRoutingTest, aiSettingsGet, aiSettingsSet } from "../src/modules/ai/commands.js";
import {
  createLlmRouter,
  embedTextsRouted,
  getAiSettings,
  getEmbeddingSettings,
  readAiConfig,
  resetHealth,
  resetSsSwitchTracker,
  setEmbedSwitchHook,
} from "../src/modules/ai/routing.js";
import { setupTestContext, type TestContext } from "./helpers.js";

let t: TestContext;
beforeAll(async () => {
  t = await setupTestContext();
});
afterAll(async () => t.cleanup());
afterEach(async () => {
  resetHealth();
  resetSsSwitchTracker();
  globalThis.fetch = realFetch;
  await t.ctx.db.delete(instanceSettings);
});
const realFetch = globalThis.fetch;

/** fetch stub keyed by hostname substring → handler */
function stubFetch(routes: Record<string, (url: string) => Response | Error>) {
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    for (const [needle, handler] of Object.entries(routes)) {
      if (url.includes(needle)) {
        const out = handler(url);
        if (out instanceof Error) throw out;
        return out;
      }
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
}
const anthropicOk = () =>
  new Response(JSON.stringify({ content: [{ type: "text", text: "A" }] }), { status: 200 });
const openaiOk = () =>
  new Response(JSON.stringify({ choices: [{ message: { content: "B" } }] }), { status: 200 });
const embedOk = (dims = 3) =>
  new Response(JSON.stringify({ data: [{ embedding: Array(dims).fill(0.1) }] }), { status: 200 });

describe("[11-IMPL] ai config storage", () => {
  it("upgrades the v1 single-provider shape to chains on read", async () => {
    await t.ctx.db.delete(instanceSettings); // another suite may share this DB — start clean
    await t.ctx.db.insert(instanceSettings).values({
      key: "ai",
      value: {
        provider: "anthropic", apiKey: "sk-ant-x", model: "claude-sonnet-5",
        anthropicWorkspaceId: "wrkspc_1",
        embeddings: { provider: "voyage", apiKey: "pa-x", model: "voyage-3.5-lite" },
      },
    });
    const cfg = await readAiConfig(t.ctx.db);
    expect(cfg.lm.chain).toHaveLength(1);
    expect(cfg.lm.chain[0]).toMatchObject({ provider: "anthropic", anthropicWorkspaceId: "wrkspc_1" });
    expect(cfg.ss.chain[0]).toMatchObject({ provider: "voyage", model: "voyage-3.5-lite" });
    // legacy readers see the same world
    expect((await getAiSettings(t.ctx.db))?.provider).toBe("anthropic");
    expect((await getEmbeddingSettings(t.ctx.db))?.provider).toBe("voyage");
  });

  it("v2 chain write merges by id — omitted apiKey keeps the stored key", async () => {
    await aiSettingsSet.run(
      { lm: { chain: [
        { provider: "anthropic", apiKey: "sk-ant-first", model: "claude-sonnet-5" },
        { provider: "openai", apiKey: "sk-proj-second" },
      ] } },
      t.ctx,
    );
    const before = await readAiConfig(t.ctx.db);
    expect(before.lm.chain).toHaveLength(2);
    expect(before.lm.chain[1]!.model).toBe("gpt-5.1"); // provider default fills in
    const ids = before.lm.chain.map((e) => e.id);

    // reorder + model change, no keys resent (masked round-trip safety)
    await aiSettingsSet.run(
      { lm: { chain: [
        { id: ids[1]!, provider: "openai", model: "gpt-5-mini" },
        { id: ids[0]!, provider: "anthropic" },
      ] } },
      t.ctx,
    );
    const after = await readAiConfig(t.ctx.db);
    expect(after.lm.chain.map((e) => e.id)).toEqual([ids[1], ids[0]]);
    expect(after.lm.chain[0]!.apiKey).toBe("sk-proj-second");
    expect(after.lm.chain[0]!.model).toBe("gpt-5-mini");
    expect(after.lm.chain[1]!.apiKey).toBe("sk-ant-first");
  });

  it("a new non-custom entry without a key is rejected; custom needs a base URL", async () => {
    await expect(
      aiSettingsSet.run({ lm: { chain: [{ provider: "openai" }] } }, t.ctx),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      aiSettingsSet.run({ lm: { chain: [{ provider: "custom", apiKey: "any-key" }] } }, t.ctx),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("settings view exposes the routing config with masked keys and health", async () => {
    await aiSettingsSet.run(
      { lm: { failover: false, retries: 3, chain: [{ provider: "anthropic", apiKey: "sk-ant-abcdef" }] } },
      t.ctx,
    );
    const view = await aiSettingsGet.run({}, t.ctx);
    expect(view.routing.lm.failover).toBe(false);
    expect(view.routing.lm.retries).toBe(3);
    expect(view.routing.lm.chain[0]).toMatchObject({
      provider: "anthropic", apiKeyMasked: "sk-ant…", health: "ok",
    });
    expect(JSON.stringify(view)).not.toContain("sk-ant-abcdef");
  });
});

describe("[11-IMPL] lm failover router", () => {
  const twoProviders = () =>
    aiSettingsSet.run(
      { lm: { retries: 1, chain: [
        { provider: "anthropic", apiKey: "sk-ant-x" },
        { provider: "openai", apiKey: "sk-proj-y" },
      ] } },
      t.ctx,
    );

  it("serves from the primary when healthy", async () => {
    await twoProviders();
    stubFetch({ "anthropic.com": anthropicOk, "openai.com": openaiOk });
    const llm = (await createLlmRouter(t.ctx.db))!;
    expect(await llm({ system: "s", user: "u" })).toBe("A");
  });

  it("falls through to the next provider when the primary fails, then skips it while down", async () => {
    await twoProviders();
    let anthropicCalls = 0;
    stubFetch({
      "anthropic.com": () => { anthropicCalls += 1; return new Error("boom"); },
      "openai.com": openaiOk,
    });
    const llm = (await createLlmRouter(t.ctx.db))!;
    expect(await llm({ system: "s", user: "u" })).toBe("B"); // failed over within the request
    expect(anthropicCalls).toBe(1);
    expect(await llm({ system: "s", user: "u" })).toBe("B"); // primary now down (retries:1) — skipped
    expect(anthropicCalls).toBe(1);
    const cfg = await readAiConfig(t.ctx.db);
    expect(cfg.routingLog.some((e) => e.text.includes("Anthropic stopped responding"))).toBe(true);
  });

  it("failover off — only the primary is called and its error surfaces", async () => {
    await aiSettingsSet.run(
      { lm: { failover: false, retries: 1, chain: [
        { provider: "anthropic", apiKey: "sk-ant-x" },
        { provider: "openai", apiKey: "sk-proj-y" },
      ] } },
      t.ctx,
    );
    stubFetch({ "anthropic.com": () => new Error("down"), "openai.com": openaiOk });
    const llm = (await createLlmRouter(t.ctx.db))!;
    await expect(llm({ system: "s", user: "u" })).rejects.toThrow("down");
  });
});

describe("[11-IMPL] embeddings routing", () => {
  it("a provider switch fires the re-embed hook exactly once", async () => {
    await aiSettingsSet.run(
      { ss: { retries: 1, chain: [
        { provider: "voyage", apiKey: "pa-x" },
        { provider: "openai", apiKey: "sk-proj-y" },
      ] } },
      t.ctx,
    );
    let hookCalls = 0;
    setEmbedSwitchHook(async () => { hookCalls += 1; });
    let voyageUp = true;
    stubFetch({
      "voyageai.com": () => (voyageUp ? embedOk() : new Error("429")),
      "openai.com": () => embedOk(),
    });
    await embedTextsRouted(t.ctx.db, ["hello"]); // primary serving
    voyageUp = false;
    await expect(embedTextsRouted(t.ctx.db, ["hello"])).rejects.toThrow(); // marks voyage down (retries:1)
    await embedTextsRouted(t.ctx.db, ["hello"]); // switched to openai → hook fires
    await embedTextsRouted(t.ctx.db, ["hello"]); // same active — no second fire
    expect(hookCalls).toBe(1);
  });
});

describe("[11-IMPL] test-the-order command", () => {
  it("pings every entry in order and reports per-entry results", async () => {
    await aiSettingsSet.run(
      { lm: { chain: [
        { provider: "anthropic", apiKey: "sk-ant-x" },
        { provider: "openai", apiKey: "sk-proj-y" },
      ] } },
      t.ctx,
    );
    stubFetch({ "anthropic.com": () => new Error("unreachable"), "openai.com": openaiOk });
    const out = await aiRoutingTest.run({ target: "lm" }, t.ctx);
    expect(out.results).toHaveLength(2);
    expect(out.results[0]).toMatchObject({ ok: false });
    expect(out.results[1]).toMatchObject({ ok: true });
  });
});
