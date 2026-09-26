/** Admin AI assistant (06-IMPL-ai-assistant) — tool loop, proposals, guardrails */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { aiAssistant, runAssistantLoop, type AssistantEvent } from "../src/modules/ai/assistant-commands.js";
import { contentTypeGet } from "../src/modules/content-type/commands.js";
import { entryCreate, entryGet, entryUpdate } from "../src/modules/entry/commands.js";
import type { AgentTurn } from "../src/modules/ai/llm-tools.js";
import { and, desc, eq } from "drizzle-orm";
import { auditLog } from "../src/db/schema/index.js";
import { setupTestContext, type TestContext } from "./helpers.js";
import { articleDefinition } from "./fixtures.js";
import { contentTypeCreate } from "../src/modules/content-type/commands.js";

let t: TestContext;

/** Scripted fake: returns the given turns in order; repeats the last one if exhausted */
const script = (turns: AgentTurn[]) => {
  let i = 0;
  t.services.llmTools = async () => turns[Math.min(i++, turns.length - 1)]!;
};

beforeAll(async () => {
  t = await setupTestContext();
  await contentTypeCreate.run(
    { uid: "article", name: "Article", definition: articleDefinition },
    t.ctx,
  );
});
afterAll(async () => t.cleanup());

describe("ai.assistant", () => {
  it("is disabled without BYOK settings (AI_NOT_CONFIGURED)", async () => {
    delete t.services.llmTools;
    await expect(
      aiAssistant.run({ messages: [{ role: "user", content: "hi" }] }, t.ctx),
    ).rejects.toMatchObject({ code: "AI_NOT_CONFIGURED" });
  });

  it("executes a multi-step tool plan — create a type, then append fields to it", async () => {
    script([
      {
        text: null,
        toolCalls: [
          {
            id: "c1",
            name: "create_content_type",
            input: {
              uid: "faq",
              name: "FAQ",
              definition: {
                displayField: "question",
                fields: [{ name: "question", type: "text", label: "Question" }],
              },
            },
          },
        ],
      },
      {
        text: null,
        toolCalls: [
          {
            id: "c2",
            name: "add_fields_to_type",
            input: { uid: "faq", fields: [{ name: "answer", type: "richtext", label: "Answer" }] },
          },
        ],
      },
      { text: "Created the FAQ type with question and answer fields.", toolCalls: [] },
    ]);
    const out = await aiAssistant.run(
      { messages: [{ role: "user", content: "FAQ 타입 만들고 답변 필드도 추가해" }] },
      t.ctx,
    );
    expect(out.reply).toContain("FAQ");
    expect(out.trace.map((x) => x.tool)).toEqual(["create_content_type", "add_fields_to_type"]);
    expect(out.trace.every((x) => x.ok)).toBe(true);
    const faq = await contentTypeGet.run({ uid: "faq" }, t.ctx);
    expect(faq.definition.fields.map((f: { name: string }) => f.name)).toEqual([
      "question",
      "answer",
    ]);
  });

  it("append-only: adding a field that already exists fails and the error reaches the model", async () => {
    script([
      {
        text: null,
        toolCalls: [
          {
            id: "d1",
            name: "add_fields_to_type",
            input: { uid: "article", fields: [{ name: "title", type: "text" }] },
          },
        ],
      },
      { text: "That field already exists.", toolCalls: [] },
    ]);
    const out = await aiAssistant.run(
      { messages: [{ role: "user", content: "add title" }] },
      t.ctx,
    );
    expect(out.trace[0]!.ok).toBe(false);
    expect(out.trace[0]!.error).toContain("already exists");
  });

  it("publish requests become proposals — never executed server-side", async () => {
    const draft = await entryCreate.run(
      { typeUid: "article", values: { title: "발행 제안 대상" } },
      t.ctx,
    );
    script([
      {
        text: null,
        toolCalls: [
          {
            id: "p1",
            name: "propose_transition",
            input: { typeUid: "article", entryId: draft.entry.id, to: "published", reason: "ready" },
          },
        ],
      },
      { text: "Confirm the card to publish.", toolCalls: [] },
    ]);
    const out = await aiAssistant.run(
      { messages: [{ role: "user", content: "이 글 발행해줘" }] },
      t.ctx,
    );
    expect(out.proposals).toEqual([
      {
        kind: "transition",
        typeUid: "article",
        entryId: draft.entry.id,
        to: "published",
        reason: "ready",
      },
    ]);
    // still a draft — the human clicks the card
    const detail = await entryGet.run({ typeUid: "article", id: draft.entry.id }, t.ctx);
    expect(detail.entry.status).toBe("draft");
  });

  it("delete requests become proposals — the entry survives, the run is audited", async () => {
    const victim = await entryCreate.run(
      { typeUid: "article", values: { title: "삭제 제안 대상" } },
      t.ctx,
    );
    script([
      {
        text: null,
        toolCalls: [
          {
            id: "del1",
            name: "propose_delete",
            input: { target: "entry", typeUid: "article", entryId: victim.entry.id, reason: "cleanup" },
          },
        ],
      },
      { text: "Confirm the card to delete.", toolCalls: [] },
    ]);
    const out = await aiAssistant.run(
      { messages: [{ role: "user", content: "저 글 지워줘" }] },
      t.ctx,
    );
    expect(out.proposals).toEqual([
      { kind: "delete", target: "entry", typeUid: "article", entryId: victim.entry.id, reason: "cleanup" },
    ]);
    const still = await entryGet.run({ typeUid: "article", id: victim.entry.id }, t.ctx);
    expect(still.entry.id).toBe(victim.entry.id); // not deleted server-side
    // one assistant-level audit row per run (P2)
    const [row] = await t.ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.workspaceId, t.workspaceId), eq(auditLog.action, "ai.assistant")))
      .orderBy(desc(auditLog.createdAt))
      .limit(1);
    expect(row).toBeTruthy();
    expect((row!.payload as { proposals: number }).proposals).toBe(1);
  });

  it("assistant-written entries carry provenance until a human saves (P3)", async () => {
    script([
      {
        text: null,
        toolCalls: [
          {
            id: "e1",
            name: "create_entry",
            input: { typeUid: "article", values: { title: "어시스턴트 작성" } },
          },
        ],
      },
      { text: "Created.", toolCalls: [] },
    ]);
    await aiAssistant.run({ messages: [{ role: "user", content: "글 하나 써줘" }] }, t.ctx);
    const rows = await import("drizzle-orm").then(async ({ eq: eqOp }) => {
      const { entries } = await import("../src/db/schema/index.js");
      return t.ctx.db.select().from(entries).where(eqOp(entries.workspaceId, t.workspaceId));
    });
    const made = rows.find(
      (r) => (r.values as { title?: string }).title === "어시스턴트 작성",
    )!;
    expect(made.aiDraft).toMatchObject({ kind: "assistant", fields: ["title"] });
    // a human save clears the mark (same review semantics as translation drafts)
    const saved = await entryUpdate.run(
      { typeUid: "article", id: made.id, values: { title: "사람이 검토함" } },
      t.ctx,
    );
    expect(saved.entry.aiDraft).toBeNull();
  });

  it("coerces plain-string richtext into a ProseMirror doc on entry writes", async () => {
    script([
      {
        text: null,
        toolCalls: [
          {
            id: "rt1",
            name: "create_entry",
            input: {
              typeUid: "article",
              values: { title: "리치텍스트 강제 변환", body: "첫 문단입니다.\n\n둘째 문단입니다." },
            },
          },
        ],
      },
      { text: "Created.", toolCalls: [] },
    ]);
    const out = await aiAssistant.run(
      { messages: [{ role: "user", content: "기사 써줘" }] },
      t.ctx,
    );
    expect(out.trace[0]).toMatchObject({ tool: "create_entry", ok: true });
    const { eq: eqOp } = await import("drizzle-orm");
    const { entries } = await import("../src/db/schema/index.js");
    const rows = await t.ctx.db.select().from(entries).where(eqOp(entries.workspaceId, t.workspaceId));
    const made = rows.find((r) => (r.values as { title?: string }).title === "리치텍스트 강제 변환")!;
    const body = made.values.body as { type: string; content: Array<{ type: string }> };
    expect(body.type).toBe("doc");
    expect(body.content).toHaveLength(2);
    expect(body.content.every((n) => n.type === "paragraph")).toBe(true);
  });

  it("streams tool progress events in order (P3 SSE source)", async () => {
    script([
      {
        text: null,
        toolCalls: [{ id: "s1", name: "list_content_types", input: {} }],
      },
      { text: "done", toolCalls: [] },
    ]);
    const events: AssistantEvent[] = [];
    const out = await runAssistantLoop(
      { messages: [{ role: "user", content: "타입 뭐 있어?" }] },
      t.ctx,
      (e) => events.push(e),
    );
    expect(out.reply).toBe("done");
    expect(events).toEqual([
      { type: "tool_start", tool: "list_content_types" },
      { type: "tool_end", tool: "list_content_types", ok: true, error: undefined },
    ]);
  });

  it("survives an unknown tool and stops at the round cap with a fallback reply", async () => {
    script([{ text: null, toolCalls: [{ id: "x", name: "no_such_tool", input: {} }] }]);
    const out = await aiAssistant.run(
      { messages: [{ role: "user", content: "loop" }] },
      t.ctx,
    );
    expect(out.reply).toContain("ran out of steps");
    expect(out.trace.length).toBe(8); // MAX_ROUNDS, one unknown-tool call per round
    expect(out.trace.every((x) => x.error === "unknown tool")).toBe(true);
    delete t.services.llmTools;
  });
});
