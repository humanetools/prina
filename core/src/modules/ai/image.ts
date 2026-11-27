/**
 * BYOK image generation (15-IMPL G3 — generative transform). Same shape as llm.ts: direct
 * HTTP, no SDKs, key from the LM chain entry. Only providers with an image API qualify
 * (PROVIDER_IMAGE); the chat model of the entry is NOT an image model, so each provider
 * has its own default image model (IMAGE_MODELS). A reference image (the product card's
 * photo) is passed when the provider supports image-to-image.
 */
import type { AiProvider, AiSettings, LlmImage } from "./llm.js";

export const PROVIDER_IMAGE: Record<AiProvider, boolean> = {
  anthropic: false,
  openai: true,
  gemini: true,
  mistral: false,
  xai: false,
  llama: false,
  custom: false,
};

export const IMAGE_MODELS: Partial<Record<AiProvider, string>> = {
  openai: "gpt-image-1",
  gemini: "gemini-2.5-flash-image",
};

export interface ImageRequest {
  prompt: string;
  /** Optional reference (the product photo) — image-to-image where the provider allows */
  reference?: LlmImage;
}
export type ImageGenerator = (req: ImageRequest) => Promise<LlmImage>;

async function readError(res: Response): Promise<string> {
  const body = await res.text().catch(() => "");
  return `Image call failed (${res.status}): ${body.slice(0, 200)}`;
}

function geminiImage(settings: AiSettings): ImageGenerator {
  return async ({ prompt, reference }) => {
    const parts = [
      ...(reference ? [{ inlineData: { mimeType: reference.mime, data: reference.base64 } }] : []),
      { text: prompt },
    ];
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(settings.model)}:generateContent`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": settings.apiKey },
        body: JSON.stringify({
          contents: [{ role: "user", parts }],
          generationConfig: { responseModalities: ["IMAGE", "TEXT"] },
        }),
      },
    );
    if (!res.ok) throw new Error(await readError(res));
    const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { mimeType: string; data: string } }> } }>;
    };
    const img = (data.candidates?.[0]?.content?.parts ?? []).find((p) => p.inlineData)?.inlineData;
    if (!img) throw new Error("Image call returned no image");
    return { mime: img.mimeType, base64: img.data };
  };
}

function openaiImage(settings: AiSettings, base = "https://api.openai.com/v1"): ImageGenerator {
  return async ({ prompt, reference }) => {
    const root = base.replace(/\/+$/, "");
    let res: Response;
    if (reference) {
      // images/edits is multipart — the reference goes in as a file part
      const form = new FormData();
      form.set("model", settings.model);
      form.set("prompt", prompt);
      form.set(
        "image",
        new Blob([Buffer.from(reference.base64, "base64")], { type: reference.mime }),
        reference.mime === "image/jpeg" ? "reference.jpg" : "reference.png",
      );
      res = await fetch(`${root}/images/edits`, {
        method: "POST",
        headers: { authorization: `Bearer ${settings.apiKey}` },
        body: form,
      });
    } else {
      res = await fetch(`${root}/images/generations`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${settings.apiKey}` },
        body: JSON.stringify({ model: settings.model, prompt, size: "1024x1024" }),
      });
    }
    if (!res.ok) throw new Error(await readError(res));
    const data = (await res.json()) as { data?: Array<{ b64_json?: string }> };
    const b64 = data.data?.[0]?.b64_json;
    if (!b64) throw new Error("Image call returned no image");
    return { mime: "image/png", base64: b64 };
  };
}

/** null when the provider has no image API — the router filters these out beforehand */
export function createImageCaller(settings: AiSettings): ImageGenerator | null {
  switch (settings.provider) {
    case "openai":
      return openaiImage(settings);
    case "gemini":
      return geminiImage(settings);
    default:
      return null;
  }
}
