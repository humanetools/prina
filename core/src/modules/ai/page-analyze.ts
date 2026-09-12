/**
 * Web-page analysis for schema design (06-IMPL-ai-assistant P2/P3) — three rungs:
 * ① the BYOK provider's server-side URL reading when configured (Gemini url_context /
 *    Anthropic web_fetch) — primary: their fetchers handle JS-rendered pages that defeat
 *    any static GET, and shell-detection heuristics proved brittle in live QA,
 * ② static fetch + parse5 extraction as the fallback (no key, OpenAI, reader failure),
 * ③ otherwise an honest PAGE UNREADABLE — the assistant must say so, never invent a schema.
 * The extraction is a pure function over HTML (testable offline); the fetch wrapper adds
 * SSRF guards, a timeout and a size cap.
 */
import { parse, type DefaultTreeAdapterTypes as T } from "parse5";
import { ValidationError } from "../../lib/errors.js";
import type { AiSettings } from "./llm.js";

const FETCH_TIMEOUT_MS = 10_000;
const MAX_BYTES = 1_500_000;
/** Model context is the budget — cap each extracted bucket */
const MAX_TEXT_BLOCKS = 40;
const MAX_SUMMARY_CHARS = 6000;

/** Hostnames/addresses that must never be fetched from a server-side tool (SSRF) */
export function assertPublicHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ValidationError(`Not a valid URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ValidationError("Only http(s) URLs can be analyzed");
  }
  const host = url.hostname.toLowerCase();
  const privatePatterns = [
    /^localhost$/, /\.local$/, /^0\.0\.0\.0$/, /^127\./, /^10\./, /^192\.168\./,
    /^172\.(1[6-9]|2\d|3[01])\./, /^169\.254\./, /^\[::1?\]$/, /^\[fc/, /^\[fd/, /^\[fe80/,
  ];
  if (privatePatterns.some((re) => re.test(host))) {
    throw new ValidationError("Private/loopback addresses cannot be analyzed");
  }
  return url;
}

interface PageSummary {
  url: string;
  title: string | null;
  metaDescription: string | null;
  ogType: string | null;
  headings: Array<{ level: string; text: string }>;
  textBlocks: string[];
  imageAlts: string[];
  hasTables: boolean;
  hasLists: boolean;
}

type Node = T.Node;
type Element = T.Element;

function isElement(n: Node): n is Element {
  return "tagName" in n;
}

function textOf(n: Node): string {
  if ("value" in n && typeof (n as { value?: unknown }).value === "string") {
    return (n as { value: string }).value;
  }
  const children = (n as { childNodes?: Node[] }).childNodes ?? [];
  return children.map(textOf).join(" ");
}

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

/** Pure extraction — walk the tree once collecting structure signals */
export function extractPageSummary(html: string, url: string): PageSummary {
  const doc = parse(html);
  const out: PageSummary = {
    url,
    title: null,
    metaDescription: null,
    ogType: null,
    headings: [],
    textBlocks: [],
    imageAlts: [],
    hasTables: false,
    hasLists: false,
  };
  const attr = (el: Element, name: string) =>
    el.attrs.find((a) => a.name === name)?.value ?? null;

  const walk = (n: Node) => {
    if (isElement(n)) {
      const tag = n.tagName;
      if (tag === "script" || tag === "style" || tag === "noscript" || tag === "svg") return;
      if (tag === "title" && !out.title) out.title = clean(textOf(n)) || null;
      else if (tag === "meta") {
        const name = attr(n, "name") ?? attr(n, "property");
        if (name === "description" && !out.metaDescription) out.metaDescription = attr(n, "content");
        if (name === "og:type") out.ogType = attr(n, "content");
      } else if (/^h[1-3]$/.test(tag)) {
        const text = clean(textOf(n));
        if (text && out.headings.length < 30) out.headings.push({ level: tag, text: text.slice(0, 150) });
      } else if ((tag === "p" || tag === "li" || tag === "dd" || tag === "figcaption") && out.textBlocks.length < MAX_TEXT_BLOCKS) {
        const text = clean(textOf(n));
        if (text.length > 25) out.textBlocks.push(text.slice(0, 300));
      } else if (tag === "img") {
        const alt = attr(n, "alt");
        if (alt && clean(alt) && out.imageAlts.length < 15) out.imageAlts.push(clean(alt).slice(0, 120));
      } else if (tag === "table") out.hasTables = true;
      else if (tag === "ul" || tag === "ol") out.hasLists = true;
    }
    for (const child of (n as { childNodes?: Node[] }).childNodes ?? []) walk(child);
    // template contents live off childNodes
    const content = (n as { content?: { childNodes?: Node[] } }).content;
    for (const child of content?.childNodes ?? []) walk(child);
  };
  walk(doc as unknown as Node);
  return out;
}

/** Render the summary as the compact text the model receives */
export function renderPageSummary(s: PageSummary): string {
  const lines = [
    `URL: ${s.url}`,
    s.title ? `Title: ${s.title}` : null,
    s.metaDescription ? `Meta description: ${s.metaDescription}` : null,
    s.ogType ? `og:type: ${s.ogType}` : null,
    `Structure: ${[s.hasTables ? "tables" : null, s.hasLists ? "lists" : null].filter(Boolean).join(", ") || "plain"}`,
    s.headings.length ? `Headings:\n${s.headings.map((h) => `  ${h.level}: ${h.text}`).join("\n")}` : null,
    s.imageAlts.length ? `Image alts: ${s.imageAlts.join(" | ")}` : null,
    s.textBlocks.length ? `Text blocks (sample):\n${s.textBlocks.map((t) => `  - ${t}`).join("\n")}` : null,
  ].filter(Boolean);
  const rendered = lines.join("\n");
  return rendered.length > MAX_SUMMARY_CHARS ? `${rendered.slice(0, MAX_SUMMARY_CHARS)}…` : rendered;
}

/** A summary with almost no content = JS-rendered shell; the model must not design from it */
export function isThinSummary(s: PageSummary): boolean {
  const contentChars =
    s.textBlocks.join("").length +
    s.headings.map((h) => h.text).join("").length +
    (s.metaDescription?.length ?? 0);
  return contentChars < 300;
}

const READER_PROMPT = (url: string) =>
  `Fetch and read this page: ${url}
Return a compact structural summary for CMS content modeling, as plain text:
- what the page is (catalog, article, product detail, ...)
- every repeated item structure (cards, table rows, list entries) with its visible fields and 2-3 sample values
- section headings and any spec/attribute tables (name the columns)
Do not propose a schema — only report the page's content structure faithfully.`;

/** Provider-side URL reading — Gemini url_context. Returns null when unusable. */
async function geminiReadUrl(settings: AiSettings, url: string): Promise<string | null> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(settings.model)}:generateContent`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": settings.apiKey },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: READER_PROMPT(url) }] }],
        tools: [{ url_context: {} }],
        generationConfig: { maxOutputTokens: 3000 },
      }),
    },
  );
  if (!res.ok) return null;
  const data = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = (data.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p.text ?? "")
    .join("")
    .trim();
  return text || null;
}

/** Provider-side URL reading — Anthropic web_fetch server tool (beta). Returns null when unusable. */
async function anthropicReadUrl(settings: AiSettings, url: string): Promise<string | null> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": settings.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "web-fetch-2025-09-10",
    },
    body: JSON.stringify({
      model: settings.model,
      max_tokens: 3000,
      messages: [{ role: "user", content: READER_PROMPT(url) }],
      tools: [{ type: "web_fetch_20250910", name: "web_fetch", max_uses: 2 }],
    }),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { content: Array<{ type: string; text?: string }> };
  const text = data.content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("")
    .trim();
  return text || null;
}

export async function providerReadUrl(
  settings: AiSettings,
  url: string,
): Promise<string | null> {
  try {
    if (settings.provider === "gemini") return await geminiReadUrl(settings, url);
    if (settings.provider === "anthropic") return await anthropicReadUrl(settings, url);
    return null; // OpenAI chat completions has no URL-reading tool
  } catch {
    return null;
  }
}

export interface AnalyzeResult {
  /** static = local extraction · provider = BYOK URL reading · unreadable = honest failure */
  method: "static" | "provider" | "unreadable";
  summary: string;
}

export async function analyzeWebPageSmart(
  rawUrl: string,
  settings: AiSettings | null,
): Promise<AnalyzeResult> {
  const url = assertPublicHttpUrl(rawUrl);
  // Provider reader first when configured: static-extraction heuristics cannot reliably
  // tell an SPA shell (nav/footer boilerplate) from real content — proven in live QA.
  if (settings) {
    const read = await providerReadUrl(settings, url.toString());
    if (read) return { method: "provider", summary: `URL: ${url}\n${read}` };
  }
  let staticSummary: PageSummary | null = null;
  try {
    staticSummary = await fetchAndExtract(url);
  } catch {
    /* fall through to the honest failure */
  }
  if (staticSummary && !isThinSummary(staticSummary)) {
    return { method: "static", summary: renderPageSummary(staticSummary) };
  }
  return {
    method: "unreadable",
    summary:
      "PAGE UNREADABLE: this page renders its content with client-side JavaScript and could not be read " +
      "(static fetch returned an app shell; the provider's URL reader was unavailable or also failed). " +
      "Tell the user the page could not be analyzed and ask for the information or a different URL. " +
      "Do NOT invent a schema from this.",
  };
}

async function fetchAndExtract(url: URL): Promise<PageSummary> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "user-agent": "Prina-Assistant/1.0 (+schema analysis)" },
      redirect: "follow",
    });
    if (!res.ok) throw new ValidationError(`Page fetch failed (${res.status})`);
    const type = res.headers.get("content-type") ?? "";
    if (!type.includes("html")) throw new ValidationError(`Not an HTML page (${type || "unknown type"})`);
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) throw new ValidationError("Page too large to analyze");
    const html = new TextDecoder().decode(buf);
    return extractPageSummary(html, url.toString());
  } catch (e) {
    if (e instanceof ValidationError) throw e;
    throw new ValidationError(
      `Could not fetch the page: ${e instanceof Error ? e.message : "network error"}`,
    );
  } finally {
    clearTimeout(timer);
  }
}
