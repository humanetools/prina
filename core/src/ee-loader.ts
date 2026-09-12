/**
 * EE dynamic loader (IMPL-ee-boundary) — the only core→ee reference is this file's single non-literal import.
 *
 * OSS build = `src/ee` physically removed. So core cannot statically import ee (§0.3);
 * this loader only imports it dynamically after checking the file exists. tsc does not
 * follow non-literal paths, so type checking passes even in trees without ee.
 * (.ts candidate is for vitest/tsx source execution — in compiled output .js matches first)
 */
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { FastifyInstance } from "fastify";
import type { Db } from "./db/client.js";
import type { EntryEventHook, Services, TransitionGuardHook } from "./commands/context.js";
import type { AppEnv } from "./app.js";

/** bootstrap workflow seed preset — core default is 2-state (draft↔published), ee provides 4-state */
export interface WorkflowPreset {
  states: string[];
  transitions: Array<[string, string]>;
}

export interface EeRegisterCtx {
  app: FastifyInstance;
  db: Db;
  services: Services;
  env: AppEnv;
}

export interface EeModule {
  /** T2.3 transition guard implementation — allowAll when not provided (OSS) */
  transitionGuard?: TransitionGuardHook;
  /** Whitelabel (T8.5) — injects branding into admin index.html. Original served when not provided */
  transformIndexHtml?: (html: string, env: AppEnv) => string;
  /** Submit/approve workflow seed (4-state) — core 2-state when not provided */
  workflowPreset?: WorkflowPreset;
  /** Called right after core route registration — EE route/command registration point */
  register?: (ctx: EeRegisterCtx) => void;
  /** Assistant tools this edition adds (06-IMPL-ai-assistant P2 — roles/workflow) */
  assistantTools?: () => import("./modules/ai/assistant-tools.js").AssistantTool[];
  /** Entry lifecycle fan-out (10-IMPL-chatbot C0) — core awaits it but swallows errors */
  onEntryEvent?: EntryEventHook;
  /** 11-IMPL: the active embedding provider switched — re-derive EE knowledge vectors */
  onEmbeddingProviderSwitch?: (db: Db) => Promise<void>;
}

export async function loadEe(): Promise<EeModule | null> {
  for (const candidate of ["./ee/index.js", "./ee/index.ts"]) {
    const p = fileURLToPath(new URL(candidate, import.meta.url));
    if (existsSync(p)) {
      const mod = (await import(pathToFileURL(p).href)) as { eeModule: EeModule };
      return mod.eeModule;
    }
  }
  return null;
}
