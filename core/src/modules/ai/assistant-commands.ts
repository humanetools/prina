/**
 * Admin AI assistant (06-IMPL-ai-assistant) — chat → tool loop over existing commands.
 * skipAudit + no own transaction on purpose: LLM roundtrips and each tool execution must
 * not share one tx; every executed tool is a full command run with its own tx/RBAC/audit.
 * Irreversible actions come back as proposals for the human to click, never executed here.
 */
import { z } from "zod";
import { auditLog } from "../../db/schema/index.js";
import { defineCommand } from "../../commands/define.js";
import { AppError } from "../../lib/errors.js";
import { getAiSettings } from "./routing.js";
import { createLlmToolCaller, type AgentMessage, type ToolResult } from "./llm-tools.js";
import { buildAssistantTools } from "./assistant-tools.js";

const MAX_ROUNDS = 8;
/** Tool results are for the model's next step, not storage — keep them bounded */
const RESULT_LIMIT = 6000;

export type AssistantProposal =
  | { kind: "transition"; typeUid: string; entryId: string; to: string; reason?: string }
  | {
      kind: "delete";
      target: "entry" | "content_type" | "component";
      typeUid: string;
      entryId?: string;
      reason?: string;
    };

export interface AssistantTraceItem {
  tool: string;
  input: Record<string, unknown>;
  ok: boolean;
  /** Error message when ok=false */
  error?: string;
}

const SYSTEM_PROMPT = `You are the built-in assistant of Prina, a headless CMS admin. You operate the CMS for the signed-in user via tools.

Ground rules:
- You may create and edit DRAFTS (entries, content types, components, translations) directly with tools.
- You must NEVER publish or change workflow status yourself. When the user asks to publish/review/approve, you MUST actually call the propose_transition tool (saying you will propose is not enough — without the tool call no confirmation card appears). The card is shown and the human decides.
- When adding fields to an existing type use add_fields_to_type (append-only). Never recreate an existing type.
- When a type needs components (for component fields or dynamic zones), create the components first, then reference them.
- Read before you write: inspect the type definition (get_content_type) before creating entries or fields for it.
- You cannot browse or analyze web pages (the feature is paused). If asked to model content after a URL, say so and ask the user to describe the content instead.
- When content shows repeated blocks or sectioned layouts, decompose them into components and a dynamic_zone instead of flat fields; spec/attribute tables become component fields or a json field.
- Deletion is proposal-only too: call propose_delete — never claim something was deleted.
- Field names are snake_case; text-like fields default to localized: true.
- Keep replies short and concrete: say what you did (or propose), listing names/ids. Answer in the user's language.
- If a tool returns an error, adjust once and retry; if it fails again, explain the failure instead of guessing.
- NEVER claim something was created, updated or done unless the tool result confirmed it without an error. If your last tool call failed, your reply MUST start by stating the failure and its reason.`;

export const assistantInputSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().min(1).max(20_000),
      }),
    )
    .min(1)
    .max(40),
  /** Where the user is — rendered into the system prompt so "this type/entry" resolves */
  context: z
    .object({
      page: z.string().max(200).optional(),
      typeUid: z.string().max(200).optional(),
      entryId: z.string().uuid().optional(),
      locale: z.string().max(20).optional(),
    })
    .optional(),
});
export type AssistantInput = z.infer<typeof assistantInputSchema>;

/** Progress events for the SSE route (P3 streaming) — the command path just ignores them */
export type AssistantEvent =
  | { type: "tool_start"; tool: string }
  | { type: "tool_end"; tool: string; ok: boolean; error?: string };

export interface AssistantResult {
  reply: string;
  trace: AssistantTraceItem[];
  proposals: AssistantProposal[];
}

/** Shared by the command (buffered) and the SSE route (streamed) */
export async function runAssistantLoop(
  input: AssistantInput,
  ctx: import("../../commands/context.js").CommandCtx,
  emit?: (e: AssistantEvent) => void,
): Promise<AssistantResult> {
    let llm = ctx.services.llmTools;
    if (!llm) {
      const settings = await getAiSettings(ctx.db);
      if (!settings) {
        throw new AppError(
          "AI_NOT_CONFIGURED",
          "AI is not configured — add an API key (BYOK) in Settings › AI",
          400,
        );
      }
      llm = createLlmToolCaller(settings);
    }

    const tools = [...buildAssistantTools(), ...(ctx.services.assistantTools ?? [])];
    const byName = new Map(tools.map((t) => [t.def.name, t]));

    const contextLines = input.context
      ? [
          "Current screen context:",
          input.context.page ? `- page: ${input.context.page}` : null,
          input.context.typeUid ? `- content type in view: ${input.context.typeUid}` : null,
          input.context.entryId ? `- entry in view: ${input.context.entryId}` : null,
          input.context.locale ? `- locale in view: ${input.context.locale}` : null,
        ]
          .filter(Boolean)
          .join("\n")
      : "";
    const system = contextLines ? `${SYSTEM_PROMPT}\n\n${contextLines}` : SYSTEM_PROMPT;

    const messages: AgentMessage[] = input.messages.map((m) => ({
      kind: "text",
      role: m.role,
      text: m.content,
    }));

    const trace: AssistantTraceItem[] = [];
    const proposals: AssistantProposal[] = [];
    let reply: string | null = null;

    for (let round = 0; round < MAX_ROUNDS; round++) {
      const turn = await llm({ system, messages, tools: tools.map((t) => t.def), maxTokens: 4096 });
      if (turn.toolCalls.length === 0) {
        reply = turn.text;
        break;
      }
      messages.push({ kind: "tool_calls", text: turn.text, calls: turn.toolCalls });
      const results: ToolResult[] = [];
      for (const call of turn.toolCalls) {
        const tool = byName.get(call.name);
        emit?.({ type: "tool_start", tool: call.name });
        let payload: string;
        if (!tool) {
          payload = JSON.stringify({ error: `Unknown tool: ${call.name}` });
          trace.push({ tool: call.name, input: call.input, ok: false, error: "unknown tool" });
        } else if (!tool.run) {
          // Proposal-only tool — record the card, tell the model it is done
          const reason = call.input.reason ? String(call.input.reason) : undefined;
          if (call.name === "propose_delete") {
            const target = String(call.input.target ?? "entry");
            proposals.push({
              kind: "delete",
              target: (target === "content_type" || target === "component" ? target : "entry"),
              typeUid: String(call.input.typeUid ?? ""),
              entryId: call.input.entryId ? String(call.input.entryId) : undefined,
              reason,
            });
          } else {
            proposals.push({
              kind: "transition",
              typeUid: String(call.input.typeUid ?? ""),
              entryId: String(call.input.entryId ?? ""),
              to: String(call.input.to ?? ""),
              reason,
            });
          }
          payload = JSON.stringify({
            ok: true,
            note: "Proposal recorded — a confirmation card is shown to the user. Do not call again; summarize.",
          });
          trace.push({ tool: call.name, input: call.input, ok: true });
        } else {
          try {
            const out = await tool.run(call.input, ctx);
            payload = JSON.stringify(out ?? {});
            trace.push({ tool: call.name, input: call.input, ok: true });
          } catch (e) {
            const message = e instanceof Error ? e.message : "Tool failed";
            payload = JSON.stringify({ error: message });
            trace.push({ tool: call.name, input: call.input, ok: false, error: message });
          }
        }
        const last = trace[trace.length - 1]!;
        emit?.({ type: "tool_end", tool: call.name, ok: last.ok, error: last.error });
        results.push({
          id: call.id,
          name: call.name,
          result: payload.length > RESULT_LIMIT ? `${payload.slice(0, RESULT_LIMIT)}…(truncated)` : payload,
        });
      }
      messages.push({ kind: "tool_results", results });
    }

    // One audit row per run (P2) — executed tools also audited individually by their commands
    await ctx.db.insert(auditLog).values({
      workspaceId: ctx.workspaceId || null,
      actorType: ctx.actor.type,
      actorId: ctx.actor.id ?? null,
      actorLabel: ctx.actor.label ?? null,
      action: "ai.assistant",
      resourceType: "ai_assistant",
      resourceId: null,
      payload: {
        tools: trace.map((x) => `${x.tool}${x.ok ? "" : "!"}`),
        proposals: proposals.length,
        failed: trace.filter((x) => !x.ok).length,
      },
    });

    return {
      reply:
        reply ??
        "I ran out of steps before finishing — the actions executed so far are listed below.",
      trace,
      proposals,
    };
}

export const aiAssistant = defineCommand({
  name: "ai.assistant",
  resource: "ai_assistant",
  skipAudit: true, // orchestration only — every executed tool audits itself via its command
  input: assistantInputSchema,
  execute: (input, ctx) => runAssistantLoop(input, ctx),
});
