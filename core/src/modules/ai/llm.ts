/**
 * BYOK LLM caller (T7.3, §2.9) — direct HTTP to each provider's API (no SDKs, minimal
 * moving parts). Key stored in instance_settings['ai'] (self-hosted BYOK pattern).
 * Air-gapped/unconfigured: only this feature disabled — everything else works (§2.9).
 * Providers: Anthropic (Messages), OpenAI (Chat Completions), Google Gemini (generateContent).
 */

export interface LlmRequest {
  system: string;
  user: string;
  maxTokens?: number;
}
export type LlmCaller = (req: LlmRequest) => Promise<string>;

/**
 * LM providers (11-IMPL routing). mistral/xai/llama/custom speak the OpenAI chat-completions
 * API — one compat caller with a per-provider base URL serves all four.
 */
export type AiProvider = "anthropic" | "openai" | "gemini" | "mistral" | "xai" | "llama" | "custom";

export interface AiSettings {
  provider: AiProvider;
  apiKey: string;
  model: string;
  /** Anthropic only — identity-linked API keys require an anthropic-workspace-id header */
  anthropicWorkspaceId?: string;
  /** custom only — OpenAI-compatible base URL (…/v1); mistral/xai/llama have fixed bases */
  baseUrl?: string;
}

/** Fixed OpenAI-compatible bases (custom brings its own) */
export const OPENAI_COMPAT_BASES: Partial<Record<AiProvider, string>> = {
  mistral: "https://api.mistral.ai/v1",
  xai: "https://api.x.ai/v1",
  llama: "https://api.llama.com/compat/v1",
};

/** Per-provider default model — mirrored by the admin model picker (AiPage) */
export const DEFAULT_MODELS: Record<AiProvider, string> = {
  anthropic: "claude-sonnet-5",
  openai: "gpt-5.1",
  gemini: "gemini-2.5-flash",
  mistral: "mistral-large-latest",
  xai: "grok-4",
  llama: "Llama-4-Maverick-17B-128E-Instruct-FP8",
  custom: "",
};
async function readError(res: Response): Promise<string> {
  const body = await res.text().catch(() => "");
  return `LLM call failed (${res.status}): ${body.slice(0, 200)}`;
}

function anthropicCaller(settings: AiSettings): LlmCaller {
  return async ({ system, user, maxTokens = 4096 }) => {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": settings.apiKey,
        "anthropic-version": "2023-06-01",
        ...(settings.anthropicWorkspaceId ? { "anthropic-workspace-id": settings.anthropicWorkspaceId } : {}),
      },
      body: JSON.stringify({
        model: settings.model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: user }],
      }),
    });
    if (!res.ok) throw new Error(await readError(res));
    const data = (await res.json()) as {
      content: Array<{ type: string; text?: string }>;
    };
    return data.content
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("");
  };
}

function openaiCaller(settings: AiSettings, base = "https://api.openai.com/v1"): LlmCaller {
  return async ({ system, user, maxTokens = 4096 }) => {
    const res = await fetch(`${base.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify({
        model: settings.model,
        // GPT-5-era models reject max_tokens; max_completion_tokens covers both generations
        max_completion_tokens: maxTokens,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (!res.ok) throw new Error(await readError(res));
    const data = (await res.json()) as {
      choices: Array<{ message?: { content?: string | null } }>;
    };
    return data.choices[0]?.message?.content ?? "";
  };
}

function geminiCaller(settings: AiSettings): LlmCaller {
  return async ({ system, user, maxTokens = 4096 }) => {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(settings.model)}:generateContent`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": settings.apiKey,
        },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: user }] }],
          generationConfig: { maxOutputTokens: maxTokens },
        }),
      },
    );
    if (!res.ok) throw new Error(await readError(res));
    const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    return (data.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p.text ?? "")
      .join("");
  };
}

export function createLlmCaller(settings: AiSettings): LlmCaller {
  switch (settings.provider) {
    case "openai":
      return openaiCaller(settings);
    case "gemini":
      return geminiCaller(settings);
    case "mistral":
    case "xai":
    case "llama":
      return openaiCaller(settings, OPENAI_COMPAT_BASES[settings.provider]!);
    case "custom":
      return openaiCaller(settings, settings.baseUrl ?? "https://localhost/v1");
    default:
      return anthropicCaller(settings);
  }
}
