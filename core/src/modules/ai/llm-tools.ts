/**
 * Multi-provider tool-calling layer (06-IMPL-ai-assistant) — one provider-agnostic
 * transcript/turn shape, mapped to Anthropic tool_use, OpenAI function calling and
 * Gemini functionDeclarations. Same BYOK settings as the plain caller (llm.ts).
 */
import type { AiSettings } from "./llm.js";

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema for the tool input (object) */
  inputSchema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  id: string;
  name: string;
  /** JSON-encoded outcome shown to the model */
  result: string;
}

export type AgentMessage =
  | { kind: "text"; role: "user" | "assistant"; text: string }
  | { kind: "tool_calls"; text: string | null; calls: ToolCall[] }
  | { kind: "tool_results"; results: ToolResult[] };

export interface AgentTurn {
  text: string | null;
  toolCalls: ToolCall[];
}

export interface ToolCallRequest {
  system: string;
  messages: AgentMessage[];
  tools: ToolDef[];
  maxTokens?: number;
}
export type LlmToolCaller = (req: ToolCallRequest) => Promise<AgentTurn>;

async function readError(res: Response): Promise<string> {
  const body = await res.text().catch(() => "");
  return `LLM call failed (${res.status}): ${body.slice(0, 300)}`;
}

/* ---------------------------------- Anthropic ---------------------------------- */

function anthropicToolCaller(settings: AiSettings): LlmToolCaller {
  return async ({ system, messages, tools, maxTokens = 4096 }) => {
    const mapped = messages.map((m) => {
      if (m.kind === "text") return { role: m.role, content: m.text };
      if (m.kind === "tool_calls")
        return {
          role: "assistant",
          content: [
            ...(m.text ? [{ type: "text", text: m.text }] : []),
            ...m.calls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.input })),
          ],
        };
      return {
        role: "user",
        content: m.results.map((r) => ({
          type: "tool_result",
          tool_use_id: r.id,
          content: r.result,
        })),
      };
    });
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": settings.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: settings.model,
        max_tokens: maxTokens,
        system,
        messages: mapped,
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema,
        })),
      }),
    });
    if (!res.ok) throw new Error(await readError(res));
    const data = (await res.json()) as {
      content: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
    };
    const text = data.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
    const toolCalls: ToolCall[] = data.content
      .filter((c) => c.type === "tool_use")
      .map((c) => ({
        id: c.id ?? `${c.name}`,
        name: c.name ?? "",
        input: (c.input as Record<string, unknown>) ?? {},
      }));
    return { text: text || null, toolCalls };
  };
}

/* ----------------------------------- OpenAI ------------------------------------ */

function openaiToolCaller(settings: AiSettings): LlmToolCaller {
  return async ({ system, messages, tools, maxTokens = 4096 }) => {
    const mapped: unknown[] = [{ role: "system", content: system }];
    for (const m of messages) {
      if (m.kind === "text") mapped.push({ role: m.role, content: m.text });
      else if (m.kind === "tool_calls")
        mapped.push({
          role: "assistant",
          content: m.text ?? null,
          tool_calls: m.calls.map((c) => ({
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: JSON.stringify(c.input) },
          })),
        });
      else
        for (const r of m.results)
          mapped.push({ role: "tool", tool_call_id: r.id, content: r.result });
    }
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify({
        model: settings.model,
        max_completion_tokens: maxTokens,
        messages: mapped,
        tools: tools.map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.inputSchema },
        })),
      }),
    });
    if (!res.ok) throw new Error(await readError(res));
    const data = (await res.json()) as {
      choices: Array<{
        message?: {
          content?: string | null;
          tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
        };
      }>;
    };
    const msg = data.choices[0]?.message;
    const toolCalls: ToolCall[] = (msg?.tool_calls ?? []).map((c) => {
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(c.function.arguments) as Record<string, unknown>;
      } catch {
        /* left empty — the tool handler reports invalid input back to the model */
      }
      return { id: c.id, name: c.function.name, input };
    });
    return { text: msg?.content || null, toolCalls };
  };
}

/* ----------------------------------- Gemini ------------------------------------ */

/**
 * Gemini accepts an OpenAPI subset, not full JSON Schema — unknown keys are hard 400s.
 * Keep only the fields its function declarations understand.
 */
const GEMINI_SCHEMA_KEYS = new Set([
  "type", "format", "description", "enum", "items", "properties", "required", "nullable",
]);
function geminiSanitizeSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(geminiSanitizeSchema);
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === "properties" && v && typeof v === "object") {
      out.properties = Object.fromEntries(
        Object.entries(v as Record<string, unknown>).map(([pk, pv]) => [pk, geminiSanitizeSchema(pv)]),
      );
    } else if (GEMINI_SCHEMA_KEYS.has(k)) {
      out[k] = geminiSanitizeSchema(v);
    }
  }
  return out;
}

function geminiToolCaller(settings: AiSettings): LlmToolCaller {
  return async ({ system, messages, tools, maxTokens = 4096 }) => {
    const contents = messages.map((m) => {
      if (m.kind === "text")
        return { role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.text }] };
      if (m.kind === "tool_calls")
        return {
          role: "model",
          parts: [
            ...(m.text ? [{ text: m.text }] : []),
            ...m.calls.map((c) => ({ functionCall: { name: c.name, args: c.input } })),
          ],
        };
      return {
        role: "user",
        parts: m.results.map((r) => ({
          functionResponse: { name: r.name, response: { output: r.result } },
        })),
      };
    });
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(settings.model)}:generateContent`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": settings.apiKey },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: system }] },
          contents,
          tools: [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: geminiSanitizeSchema(t.inputSchema) })) }],
          generationConfig: { maxOutputTokens: maxTokens },
        }),
      },
    );
    if (!res.ok) throw new Error(await readError(res));
    const data = (await res.json()) as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string; functionCall?: { name: string; args?: unknown } }> };
      }>;
    };
    const parts = data.candidates?.[0]?.content?.parts ?? [];
    const text = parts.filter((p) => p.text).map((p) => p.text).join("");
    // Gemini has no call ids — synthesize stable ones for the transcript
    const toolCalls: ToolCall[] = parts
      .filter((p) => p.functionCall)
      .map((p, i) => ({
        id: `${p.functionCall!.name}-${i}`,
        name: p.functionCall!.name,
        input: (p.functionCall!.args as Record<string, unknown>) ?? {},
      }));
    return { text: text || null, toolCalls };
  };
}

export function createLlmToolCaller(settings: AiSettings): LlmToolCaller {
  switch (settings.provider) {
    case "openai":
      return openaiToolCaller(settings);
    case "gemini":
      return geminiToolCaller(settings);
    default:
      return anthropicToolCaller(settings);
  }
}
