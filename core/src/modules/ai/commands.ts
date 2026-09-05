/**
 * AI schema generation (T7.3, §2.9) — "AI stops at drafts": this command creates no type.
 * It returns a draft + validation issues; a human reviews/edits, then calls content_type.create.
 */
import { z } from "zod";
import { sql as drizzleSql } from "drizzle-orm";
import { PermissionAction, SystemSubject } from "@prina/shared";
import { defineCommand } from "../../commands/define.js";
import { AppError, ValidationError } from "../../lib/errors.js";
import { validateDefinition } from "../../content/definition-validator.js";
import { createLlmCaller, DEFAULT_MODELS, type AiProvider } from "./llm.js";
import { EMBEDDING_DEFAULTS, embedTexts, type EmbeddingSettings } from "../delivery/embeddings.js";
import {
  appendRoutingLog,
  createLlmRouter,
  entryLabel,
  getAiSettings,
  getEmbeddingSettings,
  healthState,
  newEntryId,
  readAiConfig,
  resetHealth,
  resetSsSwitchTracker,
  writeAiConfig,
  type LmChainEntry,
  type SsChainEntry,
} from "./routing.js";
import { vectorCapabilityReadOnly } from "../delivery/semantic.js";

export const aiSettingsGet = defineCommand({
  name: "ai_settings.get",
  resource: "ai_settings",
  skipAudit: true,
  input: z.object({}).default({}),
  permission: () => ({ action: PermissionAction.Read, subject: SystemSubject.Settings }),
  async execute(_input, ctx) {
    const settings = await getAiSettings(ctx.db);
    const embeddings = await getEmbeddingSettings(ctx.db);
    const cfg = await readAiConfig(ctx.db);
    const provider = settings?.provider ?? "anthropic";
    const chainView = (chain: Array<LmChainEntry | SsChainEntry>) =>
      chain.map((e) => {
        const h = healthState(e.id);
        return {
          id: e.id,
          provider: e.provider,
          name: e.name ?? null,
          label: entryLabel(e),
          model: e.model,
          baseUrl: e.baseUrl ?? null,
          apiKeyMasked: e.apiKey ? `${e.apiKey.slice(0, 6)}…` : null,
          workspaceIdSet: !!(e as LmChainEntry).anthropicWorkspaceId,
          health: h.down ? "down" : "ok",
          downSince: h.downSince,
        };
      });
    return {
      // legacy view (primary) — existing consumers/tests
      configured: !!settings,
      provider,
      model: settings?.model ?? DEFAULT_MODELS[provider],
      apiKeyMasked: settings ? `${settings.apiKey.slice(0, 8)}…` : null,
      embeddings: {
        configured: !!embeddings,
        provider: embeddings?.provider ?? "voyage",
        model: embeddings?.model ?? EMBEDDING_DEFAULTS.voyage!.model,
        baseUrl: embeddings?.baseUrl ?? null,
        apiKeyMasked: embeddings ? `${embeddings.apiKey.slice(0, 6)}…` : null,
      },
      // 11-IMPL routing view
      routing: {
        lm: { failover: cfg.lm.failover, retries: cfg.lm.retries, timeoutSec: cfg.lm.timeoutSec, chain: chainView(cfg.lm.chain) },
        ss: { failover: cfg.ss.failover, retries: cfg.ss.retries, timeoutSec: cfg.ss.timeoutSec, chain: chainView(cfg.ss.chain) },
        log: cfg.routingLog,
      },
    };
  },
});

const LM_PROVIDERS = ["anthropic", "openai", "gemini", "mistral", "xai", "llama", "custom"] as const;
const SS_PROVIDERS = ["voyage", "openai", "custom"] as const;

const lmEntryInput = z.object({
  /** Existing entry id — omitted apiKey keeps the stored key; no id = new entry */
  id: z.string().max(40).optional(),
  provider: z.enum(LM_PROVIDERS),
  apiKey: z.string().min(4).optional(),
  model: z.string().min(1).max(200).optional(),
  name: z.string().trim().max(100).optional(),
  baseUrl: z.string().url().optional(),
  anthropicWorkspaceId: z.string().trim().max(200).optional(),
});
const ssEntryInput = z.object({
  id: z.string().max(40).optional(),
  provider: z.enum(SS_PROVIDERS),
  apiKey: z.string().min(4).optional(),
  model: z.string().min(1).max(200).optional(),
  name: z.string().trim().max(100).optional(),
  baseUrl: z.string().url().optional(),
});
const knobsInput = {
  failover: z.boolean().optional(),
  retries: z.number().int().min(1).max(9).optional(),
  timeoutSec: z.number().int().min(5).max(300).optional(),
};
const lmConfigInput = z.object({ ...knobsInput, chain: z.array(lmEntryInput).max(12).optional() });
const ssConfigInput = z.object({ ...knobsInput, chain: z.array(ssEntryInput).max(6).optional() });

/** "wrkspc_…/billing" and full console URLs reduce to the id token (live find 2026-08-31) */
const normalizeWorkspaceId = (raw: string): string =>
  raw.match(/wrkspc_[A-Za-z0-9]+/)?.[0] ?? raw;

/** Merge an incoming chain onto the stored one: apiKey omitted = keep the key of the same id */
function mergeChain<E extends { id: string; apiKey: string }>(
  stored: E[],
  incoming: Array<Partial<E> & { provider: string }>,
  prefix: "l" | "s",
): E[] {
  const byId = new Map(stored.map((e) => [e.id, e]));
  return incoming.map((inc) => {
    const prev = inc.id ? byId.get(inc.id) : undefined;
    const apiKey = inc.apiKey ?? prev?.apiKey ?? "";
    if (!apiKey && inc.provider !== "custom") {
      throw new ValidationError(`Provider '${inc.provider}' needs an API key`);
    }
    return { ...(prev ?? {}), ...inc, id: prev?.id ?? inc.id ?? newEntryId(prefix), apiKey } as unknown as E;
  });
}

export const aiSettingsSet = defineCommand({
  name: "ai_settings.set",
  resource: "ai_settings",
  input: z.object({
    // ── legacy single-provider fields (kept working — they edit the lm primary) ──
    /** null = clear, undefined = keep existing (when saving embeddings only) */
    apiKey: z.string().min(10).nullable().optional(),
    provider: z.enum(LM_PROVIDERS).default("anthropic"),
    /** Defaults to the provider's default model when omitted */
    model: z.string().min(1).optional(),
    /** Anthropic identity-linked keys require this header value; empty string clears it */
    anthropicWorkspaceId: z.string().trim().max(200).optional(),
    /** Embedding provider for semantic search (T9.3) — null clears, undefined keeps existing */
    embeddings: z
      .object({
        provider: z.enum(SS_PROVIDERS).default("voyage"),
        apiKey: z.string().min(4),
        model: z.string().min(1).optional(),
        baseUrl: z.string().url().optional(),
      })
      .nullable()
      .optional(),
    // ── 11-IMPL routing config (chains + knobs) — takes precedence when present ──
    lm: lmConfigInput.optional(),
    ss: ssConfigInput.optional(),
  }),
  permission: () => ({ action: PermissionAction.Update, subject: SystemSubject.Settings }),
  async execute(input, ctx) {
    const cfg = await readAiConfig(ctx.db);
    const prevSs = cfg.ss.chain[0];
    const prevSsSig = prevSs ? `${prevSs.provider}|${prevSs.model}|${prevSs.baseUrl ?? ""}` : "";

    // ── legacy lm fields → primary entry (v1 semantics preserved) ──
    if (input.lm === undefined && (input.apiKey !== undefined || input.model !== undefined || input.anthropicWorkspaceId !== undefined)) {
      const prev = cfg.lm.chain[0];
      const model = input.model ?? DEFAULT_MODELS[input.provider];
      if (input.apiKey === null) {
        cfg.lm.chain = cfg.lm.chain.slice(1); // clear the primary — the rest of the order moves up
      } else if (input.apiKey !== undefined) {
        const entry: LmChainEntry = {
          id: prev?.id ?? newEntryId("l"),
          provider: input.provider,
          apiKey: input.apiKey,
          model,
        };
        cfg.lm.chain = [entry, ...cfg.lm.chain.slice(1)];
      } else if (prev && input.model && input.provider === prev.provider) {
        prev.model = model; // model tweak within the same provider keeps the stored key
      }
      const primary = cfg.lm.chain[0];
      if (primary) {
        const raw = input.anthropicWorkspaceId !== undefined
          ? input.anthropicWorkspaceId // "" clears
          : primary.anthropicWorkspaceId ?? "";
        const wsid = normalizeWorkspaceId(raw);
        if (primary.provider === "anthropic" && wsid) primary.anthropicWorkspaceId = wsid;
        else delete primary.anthropicWorkspaceId;
      }
    }
    // ── legacy embeddings → ss primary (replace/clear) ──
    if (input.ss === undefined && input.embeddings !== undefined) {
      if (input.embeddings === null) cfg.ss.chain = [];
      else {
        const e = input.embeddings;
        cfg.ss.chain = [
          {
            id: cfg.ss.chain[0]?.id ?? newEntryId("s"),
            provider: e.provider,
            apiKey: e.apiKey,
            model: e.model ?? EMBEDDING_DEFAULTS[e.provider]?.model ?? "",
            ...(e.baseUrl ? { baseUrl: e.baseUrl } : {}),
          },
          ...cfg.ss.chain.slice(1),
        ];
      }
    }

    // ── v2 routing config ──
    if (input.lm) {
      if (input.lm.failover !== undefined) cfg.lm.failover = input.lm.failover;
      if (input.lm.retries !== undefined) cfg.lm.retries = input.lm.retries;
      if (input.lm.timeoutSec !== undefined) cfg.lm.timeoutSec = input.lm.timeoutSec;
      if (input.lm.chain) {
        cfg.lm.chain = mergeChain(cfg.lm.chain, input.lm.chain.map((e) => ({
          ...e,
          model: e.model || DEFAULT_MODELS[e.provider as AiProvider] || "",
          ...(e.anthropicWorkspaceId !== undefined
            ? { anthropicWorkspaceId: normalizeWorkspaceId(e.anthropicWorkspaceId) || undefined }
            : {}),
        })), "l");
        for (const e of cfg.lm.chain) {
          if (e.provider === "custom" && !e.baseUrl) throw new ValidationError("A custom endpoint needs a base URL");
          if (e.provider !== "anthropic") delete e.anthropicWorkspaceId;
        }
      }
    }
    if (input.ss) {
      if (input.ss.failover !== undefined) cfg.ss.failover = input.ss.failover;
      if (input.ss.retries !== undefined) cfg.ss.retries = input.ss.retries;
      if (input.ss.timeoutSec !== undefined) cfg.ss.timeoutSec = input.ss.timeoutSec;
      if (input.ss.chain) {
        cfg.ss.chain = mergeChain(cfg.ss.chain, input.ss.chain.map((e) => ({
          ...e,
          model: e.model || EMBEDDING_DEFAULTS[e.provider]?.model || "",
        })), "s");
        for (const e of cfg.ss.chain) {
          if (e.provider === "custom" && !e.baseUrl) throw new ValidationError("A custom endpoint needs a base URL");
        }
      }
    }

    await writeAiConfig(ctx.db, cfg);
    resetHealth(); // chain edited — forget stale health so the new order gets a fresh start
    resetSsSwitchTracker();

    // Changing the ACTIVE embedding provider/model invalidates existing vectors (spaces/
    // dimensions differ) — queue full re-embedding. ⚠ Inside the command transaction —
    // swallowing a failed query via try/catch poisons the tx with 25P02, killing the later
    // audit write (observed in CI). Pre-check with a read-only probe.
    const nowSs = cfg.ss.chain[0];
    const nowSsSig = nowSs ? `${nowSs.provider}|${nowSs.model}|${nowSs.baseUrl ?? ""}` : "";
    if (nowSsSig !== prevSsSig && nowSs && (await vectorCapabilityReadOnly(ctx.db))) {
      await ctx.db.execute(
        drizzleSql`UPDATE entry_embeddings SET status = 'pending', updated_at = now()`,
      );
    }

    const primary = cfg.lm.chain[0];
    return {
      configured: !!primary,
      provider: primary?.provider ?? input.provider,
      model: primary?.model ?? input.model ?? DEFAULT_MODELS[input.provider],
      embeddingsConfigured: cfg.ss.chain.length > 0,
      lmCount: cfg.lm.chain.length,
      ssCount: cfg.ss.chain.length,
    };
  },
  auditPayload: (i) => ({
    llmKey: i.apiKey === undefined ? "kept" : !!i.apiKey,
    provider: i.provider,
    model: i.model ?? null,
    embeddings: i.embeddings === undefined ? "kept" : !!i.embeddings,
    lmChain: i.lm?.chain ? i.lm.chain.map((e) => e.provider) : "kept",
    ssChain: i.ss?.chain ? i.ss.chain.map((e) => e.provider) : "kept",
  }),
});

/**
 * 11-IMPL "Test the order" — pings every entry in the chain in order (tiny completion /
 * one embedding). Updates the health registry and the routing log so the admin sees the
 * same state a real request would.
 */
export const aiRoutingTest = defineCommand({
  name: "ai_routing.test",
  resource: "ai_settings",
  input: z.object({ target: z.enum(["lm", "ss"]) }),
  permission: () => ({ action: PermissionAction.Update, subject: SystemSubject.Settings }),
  async execute(input, ctx) {
    const cfg = await readAiConfig(ctx.db);
    const conf: { timeoutSec: number; chain: Array<LmChainEntry | SsChainEntry> } =
      input.target === "lm" ? cfg.lm : cfg.ss;
    const timeoutSec = Math.min(conf.timeoutSec, 20);
    const results: Array<{ id: string; label: string; ok: boolean; ms: number; error: string | null }> = [];
    for (const e of conf.chain) {
      const started = Date.now();
      try {
        const run =
          input.target === "lm"
            ? createLlmCaller(e as LmChainEntry)({ system: "Health check.", user: "Reply with the single word: pong", maxTokens: 8 })
            : embedTexts(e as unknown as EmbeddingSettings, ["ping"]);
        await Promise.race([
          run,
          new Promise((_, rej) => setTimeout(() => rej(new Error(`timed out after ${timeoutSec} s`)), timeoutSec * 1000).unref?.()),
        ]);
        results.push({ id: e.id, label: entryLabel(e), ok: true, ms: Date.now() - started, error: null });
      } catch (err) {
        results.push({
          id: e.id, label: entryLabel(e), ok: false, ms: Date.now() - started,
          error: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
        });
      }
    }
    const firstOk = results.find((r) => r.ok);
    await appendRoutingLog(
      ctx.db,
      firstOk ? "ok" : "warn",
      firstOk
        ? `Test — ${firstOk.label} responded in ${(firstOk.ms / 1000).toFixed(1)} s (position ${results.indexOf(firstOk) + 1})`
        : `Test — every ${input.target === "lm" ? "language-model" : "embedding"} provider failed to respond`,
    );
    return { results };
  },
  auditPayload: (i) => ({ target: i.target }),
});

const SYSTEM_PROMPT = `당신은 CMS 콘텐츠 타입 설계자다. 사용자의 Description(또는 스프레드시트 컬럼)을 보고
콘텐츠 타입 정의 초안을 JSON으로만 응답한다. 형식:

{"uid":"lowercase_name","name":"Display name","schemaOrgType":"schema.org type or null","definition":{"displayField":"Field","fields":[...]}}

필드 타입과 Options:
- text: {minLength?,maxLength?,multiline?}  - number: {min?,max?,integer?}
- boolean  - date: {withTime?}  - enum: {options:[...]}  - json
- media: {multiple?,min?}  - richtext
- relation: {target:"type uid",relationKind:"oneToOne|oneToMany|manyToOne|manyToMany",predicate?:"semantic relation"}
- variant_axis: {axes:[{name,options:[...]}]} — Product Options(Colour/사이즈 등) 조합용, 타입당 1개

규칙: 각 필드는 name(영문 소문자 camel/snake), type, label(Korean), required? 를 갖는다.
Price/수량 같은 건 number, Description은 richtext, 이미지 컬럼은 media로. schema.org 매핑을 적극 제안.
JSON 외 다른 텍스트 금지.`;

export const aiSchemaPropose = defineCommand({
  name: "ai.schema_propose",
  resource: "ai_proposal",
  input: z.object({
    /** Natural-language description (e.g. "industrial camera product type") */
    prompt: z.string().max(4000).optional(),
    /** Excel columns → schema inference (pairs with T7.1): columns+samples from importParse */
    columns: z
      .array(z.object({ name: z.string(), samples: z.array(z.unknown()).max(10) }))
      .max(100)
      .optional(),
  }),
  permission: () => ({
    action: PermissionAction.Create,
    subject: SystemSubject.ContentTypeBuilder,
  }),
  async execute(input, ctx) {
    if (!input.prompt && !input.columns?.length) {
      throw new ValidationError("Either prompt or columns is required");
    }
    let llm = ctx.services.llm;
    if (!llm) {
      const settings = await getAiSettings(ctx.db);
      if (!settings) {
        throw new AppError(
          "AI_NOT_CONFIGURED",
          "AI is not configured — add an API key (BYOK) in Settings › System",
          400,
        );
      }
      llm = createLlmCaller(settings);
    }

    const parts: string[] = [];
    if (input.prompt) parts.push(`Description: ${input.prompt}`);
    if (input.columns?.length) {
      parts.push(
        "Spreadsheet columns and sample values:\n" +
          input.columns
            .map((c) => `- ${c.name}: ${JSON.stringify(c.samples.slice(0, 5))}`)
            .join("\n"),
      );
    }
    const raw = await llm({ system: SYSTEM_PROMPT, user: parts.join("\n\n") });

    // Strip code fences, then parse JSON
    const jsonText = raw.replace(/^```(json)?\s*/m, "").replace(/```\s*$/m, "").trim();
    let draft: {
      uid?: string;
      name?: string;
      schemaOrgType?: string | null;
      definition?: unknown;
    };
    try {
      draft = JSON.parse(jsonText);
    } catch {
      throw new ValidationError("Could not parse the AI response — try again", {
        raw: raw.slice(0, 500),
      });
    }

    // Validate the draft — return it even with issues (human fixes on the review screen)
    let issues: string[] = [];
    try {
      validateDefinition(ctx.services.registry, draft.definition);
    } catch (e) {
      issues =
        e instanceof ValidationError
          ? ((e.details as { issues?: string[] })?.issues ?? [e.message])
          : ["Definition validation failed"];
    }
    return {
      draft: {
        uid: draft.uid ?? "new_type",
        name: draft.name ?? "New type",
        schemaOrgType: draft.schemaOrgType ?? null,
        definition: draft.definition ?? { fields: [] },
      },
      issues,
      /** "AI stops at drafts" — creation goes through content_type.create after human review (§2.9) */
      reviewRequired: true,
    };
  },
  auditPayload: (i, o) => ({
    fromColumns: !!i.columns?.length,
    proposedUid: o.draft.uid,
    issueCount: o.issues.length,
  }),
});
