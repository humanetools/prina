/** Setup wizard routes (T2.1, §3.4) — after completion, everything except status returns 409 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { ValidationError } from "../../lib/errors.js";
import {
  completeSetup,
  getSetupState,
  setupAdmin,
  setupLocales,
  setupWorkspace,
} from "../../modules/setup/service.js";
import { createSession } from "../../modules/auth/sessions.js";
import { usernameSchema } from "../../modules/auth/username.js";
import { invalidateSetupCache, setSessionCookie } from "../auth-hooks.js";

const adminSchema = z.object({
  username: usernameSchema,
  password: z.string().min(8).max(200),
  name: z.string().min(1).max(200),
});
const workspaceSchema = z.object({
  name: z.string().min(1).max(200),
  settings: z.record(z.unknown()).optional(),
});
const localesSchema = z.object({
  locales: z
    .array(
      z.object({
        code: z.string().min(2).max(20),
        name: z.string().min(1).max(100),
        isDefault: z.boolean().optional(),
      }),
    )
    .min(1),
});

export function registerSetupRoutes(app: FastifyInstance, db: Db): void {
  app.get("/api/setup/status", async () => getSetupState(db));

  const guardCompleted = async () => {
    const state = await getSetupState(db);
    if (state.completed) {
      throw new ValidationError("Setup is already complete");
    }
  };

  app.post("/api/setup/admin", async (req, reply) => {
    await guardCompleted();
    const input = adminSchema.parse(req.body);
    const { userId } = await setupAdmin(db, input);
    // Issue a session right after creating the admin — keeps the wizard's later steps authenticated
    const token = await createSession(db, userId);
    setSessionCookie(req, reply, token, 30 * 24 * 60 * 60);
    return { userId, token };
  });

  app.post("/api/setup/workspace", async (req) => {
    await guardCompleted();
    await setupWorkspace(db, workspaceSchema.parse(req.body));
    return { ok: true };
  });

  app.post("/api/setup/locales", async (req) => {
    await guardCompleted();
    await setupLocales(db, localesSchema.parse(req.body));
    return { ok: true };
  });

  app.post("/api/setup/complete", async () => {
    const state = await completeSetup(db);
    invalidateSetupCache();
    return state;
  });
}
