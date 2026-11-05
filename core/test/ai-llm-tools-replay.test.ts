/**
 * Tool loop — the provider's assistant message is replayed verbatim on the next request. Providers
 * attach fields to those parts that must come back unchanged (Gemini 3 thoughtSignature, thinking
 * blocks); rebuilding them from name/args drops them, one model at a time.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createLlmToolCaller, type AgentMessage, type AgentTurn, type LlmToolCaller } from "../src/modules/ai/llm-tools.js";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const tool = { name: "list_content_types", description: "List types", inputSchema: { type: "object", properties: {} } };
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

/** two rounds: the stub answers `first` then a plain text; returns the bodies the caller sent */
async function twoRounds(llm: LlmToolCaller, first: unknown, second: unknown) {
  const bodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return json(bodies.length === 1 ? first : second);
  }) as typeof fetch;
  const messages: AgentMessage[] = [{ kind: "text", role: "user", text: "test collection 삭제해" }];
  const turn: AgentTurn = await llm({ system: "sys", messages, tools: [tool] });
  messages.push({ kind: "tool_calls", text: turn.text, calls: turn.toolCalls, raw: turn.raw });
  messages.push({ kind: "tool_results", results: turn.toolCalls.map((c) => ({ id: c.id, name: c.name, result: "[]" })) });
  await llm({ system: "sys", messages, tools: [tool] });
  return { turn, bodies };
}

describe("tool loop replays the provider's own assistant message", () => {
  it("Gemini: parts go back with thoughtSignature and all (Gemini 3 rejects the turn otherwise)", async () => {
    const parts = [
      { text: "Let me look.", thoughtSignature: "sig-text" },
      { functionCall: { name: "list_content_types", args: {} }, thoughtSignature: "sig-call" },
      { functionCall: { name: "list_content_types", args: { page: 2 } } },
    ];
    const llm = createLlmToolCaller({ provider: "gemini", apiKey: "AIza-test", model: "gemini-3-flash" });
    const { turn, bodies } = await twoRounds(llm, { candidates: [{ content: { role: "model", parts } }] }, { candidates: [{ content: { parts: [{ text: "Done." }] } }] });
    expect(turn.toolCalls.map((c) => c.name)).toEqual(["list_content_types", "list_content_types"]);
    const contents = bodies[1]!.contents as Array<{ role: string; parts: unknown[] }>;
    expect(contents[1]).toEqual({ role: "model", parts });
    expect(contents[2]!.role).toBe("user");
  });

  it("Anthropic: content blocks go back verbatim (thinking / unknown block types survive)", async () => {
    const content = [
      { type: "thinking", thinking: "…", signature: "abc" },
      { type: "text", text: "Looking." },
      { type: "tool_use", id: "toolu_1", name: "list_content_types", input: {} },
    ];
    const llm = createLlmToolCaller({ provider: "anthropic", apiKey: "sk-ant-test", model: "claude-sonnet-5" });
    const { turn, bodies } = await twoRounds(llm, { content }, { content: [{ type: "text", text: "Done." }] });
    expect(turn.toolCalls[0]!.id).toBe("toolu_1");
    const msgs = bodies[1]!.messages as Array<{ role: string; content: unknown }>;
    expect(msgs[1]).toEqual({ role: "assistant", content });
    expect(msgs[2]).toMatchObject({ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "[]" }] });
  });

  it("OpenAI: the assistant message goes back as received", async () => {
    const message = { role: "assistant", content: null, refusal: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "list_content_types", arguments: "{}" } }] };
    const llm = createLlmToolCaller({ provider: "openai", apiKey: "sk-test", model: "gpt-5.1" });
    const { turn, bodies } = await twoRounds(llm, { choices: [{ message }] }, { choices: [{ message: { role: "assistant", content: "Done." } }] });
    expect(turn.toolCalls[0]!.id).toBe("call_1");
    const msgs = bodies[1]!.messages as unknown[];
    expect(msgs[2]).toEqual(message);
    expect(msgs[3]).toEqual({ role: "tool", tool_call_id: "call_1", content: "[]" });
  });

  it("without raw (fake LLMs, tests) the turn is rebuilt from text and calls", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => { bodies.push(JSON.parse(String(init?.body))); return json({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }); }) as typeof fetch;
    const llm = createLlmToolCaller({ provider: "gemini", apiKey: "AIza-test", model: "gemini-2.5-flash" });
    await llm({ system: "sys", tools: [tool], messages: [
      { kind: "text", role: "user", text: "hi" },
      { kind: "tool_calls", text: "Looking.", calls: [{ id: "list_content_types-0", name: "list_content_types", input: { page: 1 } }] },
      { kind: "tool_results", results: [{ id: "list_content_types-0", name: "list_content_types", result: "[]" }] },
    ] });
    const contents = bodies[0]!.contents as Array<{ role: string; parts: unknown[] }>;
    expect(contents[1]).toEqual({ role: "model", parts: [{ text: "Looking." }, { functionCall: { name: "list_content_types", args: { page: 1 } } }] });
  });
});
