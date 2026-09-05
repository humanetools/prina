/**
 * AI provider routing (11-IMPL) — ordered failover chains for the language model and the
 * embedding provider, stored as JSON v2 in instance_settings['ai'] (no schema change —
 * patch-safe). The v1 single-provider shape is upgraded on read; legacy readers keep
 * working through getAiSettings()/getEmbeddingSettings(), which return the primary entry.
 *
 * Health is a process-local registry (no worker): an entry goes down after `retries`
 * consecutive failures, is skipped while down, and is retried lazily once RECHECK_MS has
 * passed (half-open). The routing log is a capped ring buffer inside the same JSON.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { instanceSettings } from "../../db/schema/index.js";
import type { Db } from "../../db/client.js";
import {
  DEFAULT_MODELS,
  createLlmCaller,
  type AiProvider,
  type AiSettings,
  type LlmCaller,
} from "./llm.js";
import {
  EMBEDDING_DEFAULTS,
  embedTexts,
  type EmbeddingSettings,
} from "../delivery/embeddings.js";

export const RECHECK_MS = 5 * 60_000;
const LOG_CAP = 50;

export interface LmChainEntry {
  id: string;
  provider: AiProvider;
  apiKey: string;
  model: string;
  /** custom only */
  name?: string;
  baseUrl?: string;
  /** anthropic only */
  anthropicWorkspaceId?: string;
}
export type SsProvider = EmbeddingSettings["provider"];
export interface SsChainEntry {
  id: string;
  provider: SsProvider;
  apiKey: string;
  model: string;
  name?: string;
  baseUrl?: string;
}
export interface ChainConfig<E> {
  failover: boolean;
  retries: number;
  timeoutSec: number;
  chain: E[];
}
export interface RoutingLogEvent {
  t: number;
  kind: "ok" | "warn" | "muted";
  text: string;
}
export interface AiConfig {
  lm: ChainConfig<LmChainEntry>;
  ss: ChainConfig<SsChainEntry>;
  routingLog: RoutingLogEvent[];
}

const defaultKnobs = { failover: true, retries: 2, timeoutSec: 30 };

/** v1 legacy shape (pre-11-IMPL) */
interface V1Shape {
  provider?: string;
  apiKey?: string;
  model?: string;
  anthropicWorkspaceId?: string;
  embeddings?: { provider?: string; apiKey?: string; model?: string; baseUrl?: string };
}

function upgradeV1(v: V1Shape): AiConfig {
  const lmChain: LmChainEntry[] = v.apiKey
    ? [{
        id: "l1",
        provider: (v.provider as AiProvider) ?? "anthropic",
        apiKey: v.apiKey,
        model: v.model ?? DEFAULT_MODELS[(v.provider as AiProvider) ?? "anthropic"],
        ...(v.anthropicWorkspaceId ? { anthropicWorkspaceId: v.anthropicWorkspaceId } : {}),
      }]
    : [];
  const e = v.embeddings;
  const ssChain: SsChainEntry[] = e?.apiKey
    ? [{
        id: "s1",
        provider: (e.provider as SsProvider) ?? "voyage",
        apiKey: e.apiKey,
        model: e.model ?? EMBEDDING_DEFAULTS[(e.provider as string) ?? "voyage"]?.model ?? "",
        ...(e.baseUrl ? { baseUrl: e.baseUrl } : {}),
      }]
    : [];
  return {
    lm: { ...defaultKnobs, chain: lmChain },
    ss: { ...defaultKnobs, chain: ssChain },
    routingLog: [],
  };
}

function normalizeKnobs<E>(c: Partial<ChainConfig<E>> | undefined, chain: E[]): ChainConfig<E> {
  return {
    failover: c?.failover ?? defaultKnobs.failover,
    retries: Math.min(9, Math.max(1, c?.retries ?? defaultKnobs.retries)),
    timeoutSec: Math.min(300, Math.max(5, c?.timeoutSec ?? defaultKnobs.timeoutSec)),
    chain,
  };
}

export async function readAiConfig(db: Db): Promise<AiConfig> {
  const [row] = await db
    .select()
    .from(instanceSettings)
    .where(eq(instanceSettings.key, "ai"))
    .limit(1);
  const v = row?.value as (Partial<AiConfig> & V1Shape) | undefined;
  if (!v) return { lm: { ...defaultKnobs, chain: [] }, ss: { ...defaultKnobs, chain: [] }, routingLog: [] };
  if (!v.lm && !v.ss) return upgradeV1(v);
  return {
    lm: normalizeKnobs(v.lm, (v.lm?.chain ?? []) as LmChainEntry[]),
    ss: normalizeKnobs(v.ss, (v.ss?.chain ?? []) as SsChainEntry[]),
    routingLog: Array.isArray(v.routingLog) ? (v.routingLog as RoutingLogEvent[]).slice(0, LOG_CAP) : [],
  };
}

export async function writeAiConfig(db: Db, cfg: AiConfig): Promise<void> {
  const value = { lm: cfg.lm, ss: cfg.ss, routingLog: cfg.routingLog.slice(0, LOG_CAP) };
  await db
    .insert(instanceSettings)
    .values({ key: "ai", value })
    .onConflictDoUpdate({ target: instanceSettings.key, set: { value, updatedAt: new Date() } });
}

/** Best-effort log append — routing must never fail because logging did */
export async function appendRoutingLog(
  db: Db,
  kind: RoutingLogEvent["kind"],
  text: string,
): Promise<void> {
  try {
    const cfg = await readAiConfig(db);
    cfg.routingLog = [{ t: Date.now(), kind, text }, ...cfg.routingLog].slice(0, LOG_CAP);
    await writeAiConfig(db, cfg);
  } catch {
    /* ignore */
  }
}

export function newEntryId(prefix: "l" | "s"): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

// ── health registry (process-local) ─────────────────────────────────────────
interface HealthCell {
  consecFails: number;
  downSince: number | null;
}
const health = new Map<string, HealthCell>();
const cell = (id: string): HealthCell => {
  let c = health.get(id);
  if (!c) {
    c = { consecFails: 0, downSince: null };
    health.set(id, c);
  }
  return c;
};
export function healthState(id: string): { down: boolean; downSince: number | null; recheckDue: boolean } {
  const c = cell(id);
  const down = c.downSince !== null;
  return { down, downSince: c.downSince, recheckDue: down && Date.now() - c.downSince! >= RECHECK_MS };
}
export function noteSuccess(id: string): { restored: boolean } {
  const c = cell(id);
  const restored = c.downSince !== null;
  c.consecFails = 0;
  c.downSince = null;
  return { restored };
}
export function noteFailure(id: string, retries: number): { wentDown: boolean } {
  const c = cell(id);
  c.consecFails += 1;
  if (c.downSince !== null) {
    c.downSince = Date.now(); // failed half-open probe — re-arm the recheck window
    return { wentDown: false };
  }
  if (c.consecFails >= retries) {
    c.downSince = Date.now();
    return { wentDown: true };
  }
  return { wentDown: false };
}
/** Test hook + chain edits — forget health for removed/replaced entries */
export function resetHealth(id?: string): void {
  if (id) health.delete(id);
  else health.clear();
}

export function entryLabel(e: { name?: string; provider: string }): string {
  return e.name || PROVIDER_LABELS[e.provider] || e.provider;
}
export const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  gemini: "Google Gemini",
  mistral: "Mistral",
  xai: "xAI",
  llama: "Meta Llama",
  voyage: "Voyage AI",
  custom: "Custom endpoint",
};

function withTimeout<T>(p: Promise<T>, seconds: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${what} timed out after ${seconds} s`)), seconds * 1000).unref?.(),
    ),
  ]);
}

function lmEntrySettings(e: LmChainEntry): AiSettings {
  return {
    provider: e.provider,
    apiKey: e.apiKey,
    model: e.model,
    ...(e.anthropicWorkspaceId ? { anthropicWorkspaceId: e.anthropicWorkspaceId } : {}),
    ...(e.baseUrl ? { baseUrl: e.baseUrl } : {}),
  };
}

/** Candidates for one request: down entries are skipped unless their recheck is due */
export function pickCandidates<E extends { id: string }>(cfg: ChainConfig<E>): E[] {
  const chain = cfg.failover ? cfg.chain : cfg.chain.slice(0, 1);
  const ready = chain.filter((e) => {
    const h = healthState(e.id);
    return !h.down || h.recheckDue;
  });
  // Everything down and no recheck due — try the whole order anyway rather than failing cold
  return ready.length > 0 ? ready : chain;
}

/**
 * LM router — one caller that walks the chain. Returns null when nothing is connected
 * (same contract as getAiSettings() === null for legacy callers).
 */
export async function createLlmRouter(db: Db): Promise<LlmCaller | null> {
  const cfg = await readAiConfig(db);
  if (cfg.lm.chain.length === 0) return null;
  return async (req) => {
    const { failover, retries, timeoutSec } = cfg.lm;
    const candidates = pickCandidates(cfg.lm);
    let lastErr: unknown = new Error("No AI provider is connected");
    for (const e of candidates) {
      try {
        const out = await withTimeout(
          createLlmCaller(lmEntrySettings(e))(req),
          timeoutSec,
          entryLabel(e),
        );
        if (noteSuccess(e.id).restored) {
          void appendRoutingLog(db, "ok", `${entryLabel(e)} healthy again on recheck — restored`);
        }
        return out;
      } catch (err) {
        lastErr = err;
        if (noteFailure(e.id, retries).wentDown) {
          void appendRoutingLog(
            db,
            "warn",
            `${entryLabel(e)} stopped responding${failover ? " — trying the next provider in the order" : ""}`,
          );
        }
        if (!failover) break;
      }
    }
    throw lastErr;
  };
}

// ── embeddings routing ───────────────────────────────────────────────────────
function ssEntrySettings(e: SsChainEntry): EmbeddingSettings {
  return { provider: e.provider, apiKey: e.apiKey, model: e.model, baseUrl: e.baseUrl };
}

/**
 * The ACTIVE embedding entry — first non-down entry (failover) or the primary. Unlike the
 * LM, embeddings cannot fail over per request: vectors from different providers live in
 * incompatible spaces, so a switch re-embeds everything (the caller handles that via
 * embedSwitchWatcher below).
 */
export async function getActiveSsEntry(db: Db): Promise<{ entry: SsChainEntry; cfg: AiConfig } | null> {
  const cfg = await readAiConfig(db);
  if (cfg.ss.chain.length === 0) return null;
  const candidates = pickCandidates(cfg.ss);
  return { entry: candidates[0] ?? cfg.ss.chain[0]!, cfg };
}

export type EmbedSwitchHook = (db: Db) => Promise<void>;
let onEmbedSwitch: EmbedSwitchHook | null = null;
/** Wired at boot: re-embed pipelines (search pending flip + EE knowledge rebuild) */
export function setEmbedSwitchHook(hook: EmbedSwitchHook): void {
  onEmbedSwitch = hook;
}
let lastActiveSsId: string | null = null;

/**
 * Routed embedTexts — calls the active entry; a failure marks health (down after
 * `retries`) so the NEXT call switches entries, which fires the re-embed hook once.
 */
export async function embedTextsRouted(db: Db, texts: string[]): Promise<number[][]> {
  const active = await getActiveSsEntry(db);
  if (!active) throw new Error("No embedding provider is connected");
  const { entry, cfg } = active;
  if (lastActiveSsId !== null && lastActiveSsId !== entry.id) {
    void appendRoutingLog(db, "warn", `${entryLabel(entry)} took over embeddings — re-embedding queued (vector spaces differ per provider)`);
    if (onEmbedSwitch) await onEmbedSwitch(db).catch(() => {});
  }
  lastActiveSsId = entry.id;
  try {
    const out = await withTimeout(
      embedTexts(ssEntrySettings(entry), texts),
      cfg.ss.timeoutSec,
      entryLabel(entry),
    );
    if (noteSuccess(entry.id).restored) {
      void appendRoutingLog(db, "ok", `${entryLabel(entry)} healthy again on recheck — restored`);
    }
    return out;
  } catch (err) {
    if (noteFailure(entry.id, cfg.ss.retries).wentDown) {
      void appendRoutingLog(db, "warn", `${entryLabel(entry)} stopped responding (embeddings)`);
    }
    throw err;
  }
}
/** Test hook — reset the switch tracker between tests */
export function resetSsSwitchTracker(): void {
  lastActiveSsId = null;
}

// ── legacy readers (v1 contract preserved for existing consumers) ────────────
/** The PRIMARY lm entry in the old single-provider shape — null = nothing connected */
export async function getAiSettings(db: Db): Promise<AiSettings | null> {
  const cfg = await readAiConfig(db);
  const e = cfg.lm.chain[0];
  if (!e || (!e.apiKey && e.provider !== "custom")) return null;
  return lmEntrySettings(e);
}

/** The ACTIVE ss entry (first healthy in the order) in the old shape — null = none */
export async function getEmbeddingSettings(db: Db): Promise<EmbeddingSettings | null> {
  const active = await getActiveSsEntry(db);
  if (!active) return null;
  const e = active.entry;
  if (!e.apiKey || (e.provider === "custom" && !e.baseUrl)) return null;
  return ssEntrySettings(e);
}
