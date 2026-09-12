/**
 * Command context (T1.4) — execution environment shared by UI (REST) and MCP.
 * Permission hook and transition guard implementations are injected in Phase 2 (default: allow all).
 */
import type { EventEmitter } from "node:events";
import type { ActorType } from "@prina/shared";
import type { Db } from "../db/client.js";
import type { FieldTypeRegistry } from "../content/field-types/registry.js";
import type { SchemaCache } from "../content/schema-compiler.js";
import type { StorageServices } from "../storage/index.js";

export interface Actor {
  type: ActorType;
  /** human=user id, ai=MCP client identifier (e.g. mcp:ops-01) */
  id?: string;
  label?: string;
  /** Role bindings for ai actors — filled by MCP token↔role mapping (T6.1) */
  roleIds?: string[];
}

/** Permission requirement declared by a command (T2.2): type×CRUD×field×locale */
export interface PermissionRequest {
  /** A PermissionAction value or an extension string */
  action: string;
  /** contentSubject(uid) or a SystemSubject value */
  subject: string;
  locale?: string;
  /** Fields targeted by the write — used for field-level save denial */
  fields?: string[];
}

export interface CommandMeta {
  name: string;
  resource: string;
  permission: PermissionRequest | null;
}

/** Permission hook signature — replaced by the RBAC implementation in Phase 2 (T2.2) */
export type AuthorizeHook = (
  command: CommandMeta,
  input: unknown,
  ctx: CommandCtx,
) => Promise<void>;

/** Workflow transition guard hook — replaced by the implementation in Phase 2 (T2.3) */
export type TransitionGuardHook = (
  args: { typeUid: string; from: string; to: string },
  ctx: CommandCtx,
) => Promise<void>;

/**
 * Entry lifecycle event handed to the edition hook (EE chatbot knowledge derivation, C0).
 * "updated" fires only for edits while published — draft churn is not a lifecycle event here.
 */
export interface EntryEvent {
  kind: "published" | "unpublished" | "updated" | "deleted";
  entryId: string;
  workspaceId: string;
  typeUid: string;
  locale?: string;
}

/**
 * Edition entry-event hook — receives the caller's db handle so any queue write joins the
 * command transaction (and rolls back with it). Implementations must be DML-only and use
 * read-only capability probes (no DDL inside a caller's transaction — CI-CD §6-2).
 */
export type EntryEventHook = (ev: EntryEvent, db: Db) => Promise<void>;

export interface Services {
  registry: FieldTypeRegistry;
  schemas: SchemaCache;
  authorize: AuthorizeHook;
  transitionGuard: TransitionGuardHook;
  /** Storage adapter + imgproxy signer (T4.1/T4.2) */
  storage: StorageServices;
  /** Internal event bus — 'content-types-changed'(workspaceId) → MCP listChanged (T6.2) */
  events: EventEmitter;
  /** BYOK LLM caller (T7.3) — if not injected, created from instance settings; feature disabled without either */
  llm?: import("../modules/ai/llm.js").LlmCaller;
  /** BYOK tool-calling caller (06-IMPL-ai-assistant) — same injection pattern as llm */
  llmTools?: import("../modules/ai/llm-tools.js").LlmToolCaller;
  /** Extra assistant tools contributed by the edition (EE: roles/workflow) — empty in OSS */
  assistantTools?: import("../modules/ai/assistant-tools.js").AssistantTool[];
  /** Entry lifecycle fan-out (EE chatbot knowledge derivation) — absent in OSS */
  onEntryEvent?: EntryEventHook;
}

export interface CommandCtx {
  db: Db;
  workspaceId: string;
  actor: Actor;
  services: Services;
}

export const allowAllAuthorize: AuthorizeHook = async () => {};
export const allowAllTransitionGuard: TransitionGuardHook = async () => {};

/**
 * Fire the edition entry-event hook — no-op without EE. Failures are logged and swallowed:
 * an EE hook must never break the core command that triggered it.
 */
export async function emitEntryEvent(ctx: CommandCtx, ev: EntryEvent): Promise<void> {
  if (!ctx.services.onEntryEvent) return;
  try {
    await ctx.services.onEntryEvent(ev, ctx.db);
  } catch (err) {
    console.error(`[entry-event] ${ev.kind} hook failed for entry ${ev.entryId}:`, err);
  }
}
