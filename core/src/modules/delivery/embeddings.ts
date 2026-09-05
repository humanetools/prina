/**
 * BYOK embedding caller (T9.3) — Anthropic has no embeddings API, so a separate provider.
 * Stored in instance_settings['ai'].embeddings; unconfigured disables only semantic search
 * (§2.9 fallback principle). voyage (Anthropic partner) / openai / custom (OpenAI-compatible
 * URL) — request/response shapes are identical.
 */

export interface EmbeddingSettings {
  provider: "voyage" | "openai" | "custom";
  apiKey: string;
  model: string;
  /** custom only — full OpenAI-compatible /embeddings URL */
  baseUrl?: string;
}

export const EMBEDDING_DEFAULTS: Record<string, { model: string; url: string }> = {
  voyage: { model: "voyage-3.5-lite", url: "https://api.voyageai.com/v1/embeddings" },
  openai: { model: "text-embedding-3-small", url: "https://api.openai.com/v1/embeddings" },
};

/** Text batch → embedding batch. Inputs truncated at 8,000 chars (protects model context). */
export async function embedTexts(
  settings: EmbeddingSettings,
  texts: string[],
): Promise<number[][]> {
  const url =
    settings.provider === "custom" ? settings.baseUrl! : EMBEDDING_DEFAULTS[settings.provider]!.url;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify({
      model: settings.model,
      input: texts.map((t) => t.slice(0, 8000)),
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Embedding call failed (${res.status}): ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
  const vectors = (data.data ?? []).map((d) => d.embedding ?? []);
  if (vectors.length !== texts.length || vectors.some((v) => v.length === 0)) {
    throw new Error("Embedding response shape mismatch");
  }
  return vectors;
}
