/**
 * Model lists straight from the providers (31-IMPL). A hard-coded catalog goes stale the day a provider
 * retires a model — the admin picker asks here instead, with the user's own key.
 * Voyage has no list endpoint, so its documented models are the one catalog kept in code.
 */
import { AppError, ValidationError } from "../../lib/errors.js";
import { OPENAI_COMPAT_BASES, type AiProvider } from "./llm.js";

export type ModelTarget = "lm" | "ss";

export interface ModelInfo {
  id: string;
  label: string;
}
export interface ModelList {
  models: ModelInfo[];
  /** live = the provider answered; catalog = a documented list (no list endpoint) */
  source: "live" | "catalog";
  note?: string;
}

export interface ModelListRequest {
  target: ModelTarget;
  provider: string;
  apiKey?: string;
  baseUrl?: string;
  anthropicWorkspaceId?: string;
}

/** Voyage AI (docs.voyageai.com, 2026-09-22) — current models first, then still-served legacy ones */
export const VOYAGE_CATALOG: ModelInfo[] = [
  { id: "voyage-4-large", label: "voyage-4-large — best quality, flexible dimensions" },
  { id: "voyage-4", label: "voyage-4 — general purpose" },
  { id: "voyage-4-lite", label: "voyage-4-lite — fastest, cheapest" },
  { id: "voyage-code-4", label: "voyage-code-4 — code" },
  { id: "voyage-finance-2", label: "voyage-finance-2" },
  { id: "voyage-law-2", label: "voyage-law-2" },
  { id: "voyage-3-large", label: "voyage-3-large (legacy)" },
  { id: "voyage-3.5", label: "voyage-3.5 (legacy)" },
  { id: "voyage-3.5-lite", label: "voyage-3.5-lite (legacy)" },
  { id: "voyage-code-3", label: "voyage-code-3 (legacy)" },
  { id: "voyage-multilingual-2", label: "voyage-multilingual-2 (legacy)" },
];

/** OpenAI lists every model in one place — these families cannot serve chat completions */
const OPENAI_NOT_CHAT = /embedding|whisper|tts|dall-e|moderation|realtime|transcribe|audio|image|sora|babbage|davinci/i;

const providerError = (provider: string, status: number, body: string) =>
  new AppError("AI_PROVIDER_ERROR", `${provider} did not return its model list (${status}): ${body.slice(0, 300)}`, 502);

async function getJson(url: string, headers: Record<string, string>, provider: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { headers });
  } catch (err) {
    throw new AppError("AI_PROVIDER_ERROR", `${provider} could not be reached: ${err instanceof Error ? err.message : String(err)}`, 502);
  }
  if (!res.ok) throw providerError(provider, res.status, await res.text().catch(() => ""));
  return res.json();
}

const byId = (a: ModelInfo, b: ModelInfo) => a.id.localeCompare(b.id);

async function anthropicModels(req: ModelListRequest): Promise<ModelList> {
  const json = (await getJson("https://api.anthropic.com/v1/models?limit=1000", {
    "x-api-key": req.apiKey!,
    "anthropic-version": "2023-06-01",
    ...(req.anthropicWorkspaceId ? { "anthropic-workspace-id": req.anthropicWorkspaceId } : {}),
  }, "Anthropic")) as { data?: Array<{ id: string; display_name?: string }> };
  // the API lists newest first — keep that order
  return { source: "live", models: (json.data ?? []).map((m) => ({ id: m.id, label: m.display_name ? `${m.display_name} (${m.id})` : m.id })) };
}

async function openaiCompatModels(req: ModelListRequest, base: string, provider: string): Promise<ModelList> {
  const json = (await getJson(`${base.replace(/\/+$/, "")}/models`, {
    ...(req.apiKey ? { authorization: `Bearer ${req.apiKey}` } : {}),
  }, provider)) as { data?: Array<{ id: string }> };
  let ids = (json.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string");
  if (provider === "OpenAI") ids = req.target === "ss" ? ids.filter((id) => /embedding/i.test(id)) : ids.filter((id) => !OPENAI_NOT_CHAT.test(id));
  return { source: "live", models: ids.map((id) => ({ id, label: id })).sort(byId) };
}

async function geminiModels(req: ModelListRequest): Promise<ModelList> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=${encodeURIComponent(req.apiKey!)}`;
  const json = (await getJson(url, {}, "Gemini")) as { models?: Array<{ name: string; displayName?: string; supportedGenerationMethods?: string[] }> };
  const method = req.target === "ss" ? "embedContent" : "generateContent";
  const models = (json.models ?? [])
    .filter((m) => (m.supportedGenerationMethods ?? []).includes(method))
    .map((m) => {
      const id = m.name.replace(/^models\//, "");
      return { id, label: m.displayName ? `${m.displayName} (${id})` : id };
    })
    .sort(byId);
  return { source: "live", models };
}

/** The models a provider offers for the target, with the caller's key. Throws 502 when the provider refuses. */
export async function listProviderModels(req: ModelListRequest): Promise<ModelList> {
  const { target, provider } = req;
  if (provider === "custom") {
    if (!req.baseUrl) throw new ValidationError("A custom endpoint needs its base URL to list models");
    // ss custom entries store the full …/embeddings URL; the list lives next to it
    const base = target === "ss" ? req.baseUrl.replace(/\/embeddings\/?$/, "") : req.baseUrl;
    return openaiCompatModels(req, base, "The custom endpoint");
  }
  if (target === "ss") {
    if (provider === "voyage") return { source: "catalog", models: VOYAGE_CATALOG, note: "Voyage AI has no model-list API — this is the documented list." };
    if (provider === "openai") return openaiCompatModels(req, "https://api.openai.com/v1", "OpenAI");
    throw new ValidationError(`Unknown embedding provider '${provider}'`);
  }
  if (!req.apiKey) throw new ValidationError("An API key is needed to list models");
  switch (provider as AiProvider) {
    case "anthropic": return anthropicModels(req);
    case "openai": return openaiCompatModels(req, "https://api.openai.com/v1", "OpenAI");
    case "gemini": return geminiModels(req);
    case "mistral": case "xai": case "llama":
      return openaiCompatModels(req, OPENAI_COMPAT_BASES[provider as AiProvider]!, provider);
    default:
      throw new ValidationError(`Unknown provider '${provider}'`);
  }
}
