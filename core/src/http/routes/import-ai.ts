/** Import/preset/AI REST adapter (Phase 7) — command calls only */
import type { FastifyInstance } from "fastify";
import type { Db } from "../../db/client.js";
import type { Services } from "../../commands/context.js";
import { buildCommandCtx } from "../request-context.js";
import {
  importExecute,
  importParse,
  importValidate,
} from "../../modules/import/commands.js";
import { presetInstall, presetList } from "../../modules/preset/commands.js";
import {
  aiSchemaPropose,
  aiSettingsGet,
  aiSettingsSet, aiRoutingTest,
} from "../../modules/ai/commands.js";
import { entryAiTranslate } from "../../modules/ai/translate-commands.js";
import {
  aiAssistant,
  assistantInputSchema,
  runAssistantLoop,
} from "../../modules/ai/assistant-commands.js";

export function registerImportAiRoutes(
  app: FastifyInstance,
  db: Db,
  services: Services,
): void {
  const ctx = (req: Parameters<typeof buildCommandCtx>[0]) =>
    buildCommandCtx(req, db, services);

  // Import (T7.1)
  app.post("/api/import/parse", async (req) =>
    importParse.run(req.body, await ctx(req)),
  );
  app.post("/api/import/validate", async (req) =>
    importValidate.run(req.body, await ctx(req)),
  );
  app.post("/api/import/execute", async (req) =>
    importExecute.run(req.body, await ctx(req)),
  );

  // Presets (T7.2)
  app.get("/api/presets", async (req) => presetList.run({}, await ctx(req)));
  app.post("/api/presets/:presetId/install", async (req, reply) => {
    const { presetId } = req.params as { presetId: string };
    return reply
      .status(201)
      .send(await presetInstall.run({ ...(req.body as object), presetId }, await ctx(req)));
  });

  // AI (T7.3)
  app.get("/api/ai/settings", async (req) => aiSettingsGet.run({}, await ctx(req)));
  app.put("/api/ai/settings", async (req) => aiSettingsSet.run(req.body, await ctx(req)));
  // 11-IMPL routing — ping the provider order in sequence
  app.post("/api/ai/test", async (req) => aiRoutingTest.run(req.body, await ctx(req)));
  app.post("/api/ai/schema-propose", async (req) =>
    aiSchemaPropose.run(req.body, await ctx(req)),
  );
  // Locale translation (IMPL-ai-locale-translation) — one target locale per call
  app.post("/api/ai/translate", async (req, reply) =>
    reply.status(201).send(await entryAiTranslate.run(req.body, await ctx(req))),
  );
  // Admin assistant (06-IMPL-ai-assistant) — chat → tool loop; irreversibles come back as proposals
  app.post("/api/ai/assistant", async (req) => aiAssistant.run(req.body, await ctx(req)));

  // Streaming variant (P3) — SSE progress events per tool, then the full result.
  // Same auth/context path; hijacked so fastify does not double-respond.
  app.post("/api/ai/assistant/stream", async (req, reply) => {
    const parsed = assistantInputSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(422).send({
        error: { code: "VALIDATION_ERROR", message: "assistant input is not valid" },
      });
    }
    const commandCtx = await ctx(req);
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const send = (event: string, data: unknown) =>
      reply.raw.write(`event: ${event}
data: ${JSON.stringify(data)}

`);
    try {
      const out = await runAssistantLoop(parsed.data, commandCtx, (e) => send("progress", e));
      send("done", out);
    } catch (e) {
      send("error", {
        message: e instanceof Error ? e.message : "Assistant failed",
        code: (e as { code?: string }).code,
      });
    }
    reply.raw.end();
  });
}
