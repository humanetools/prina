/**
 * Settings REST adapter — locales, default roles/users, workspace, license (command calls only).
 * EE surfaces (custom role editing, workflow guard, audit viewing) live in src/ee/routes.ts (IMPL-ee-boundary).
 */
import type { FastifyInstance } from "fastify";
import type { Db } from "../../db/client.js";
import type { Services } from "../../commands/context.js";
import { buildCommandCtx } from "../request-context.js";
import {
  localeCreate,
  localeDelete,
  localeList,
  localeUpdate,
} from "../../modules/locale/commands.js";
import { roleList, userCreate, userList } from "../../modules/rbac/admin-commands.js";
import {
  workspaceGetSettings,
  workspaceUpdateSettings,
} from "../../modules/workspace/commands.js";
import { licenseStatusGet } from "../../modules/license/commands.js";
import { workflowGet } from "../../modules/workflow/queries.js";

export function registerSettingsRoutes(
  app: FastifyInstance,
  db: Db,
  services: Services,
): void {
  const ctx = (req: Parameters<typeof buildCommandCtx>[0]) =>
    buildCommandCtx(req, db, services);

  // Locales (T2.4)
  app.get("/api/locales", async (req) => localeList.run({}, await ctx(req)));
  app.post("/api/locales", async (req, reply) =>
    reply.status(201).send(await localeCreate.run(req.body, await ctx(req))),
  );
  app.patch("/api/locales/:code", async (req) => {
    const { code } = req.params as { code: string };
    return localeUpdate.run({ ...(req.body as object), code }, await ctx(req));
  });
  app.delete("/api/locales/:code", async (req) => {
    const { code } = req.params as { code: string };
    return localeDelete.run({ code }, await ctx(req));
  });

  // Roles & Users (T2.2) — default role viewing and user management are core; custom role creation/editing is EE
  app.get("/api/roles", async (req) => roleList.run({}, await ctx(req)));
  app.get("/api/users", async (req) => userList.run({}, await ctx(req)));
  app.post("/api/users", async (req, reply) =>
    reply.status(201).send(await userCreate.run(req.body, await ctx(req))),
  );

  // Workflow read (T2.3) — OSS admin also needs it to render the status chain. Guard editing is EE
  app.get("/api/workflow", async (req) => workflowGet.run({}, await ctx(req)));

  // Workspace settings (T5.4: dataLayer global currency, etc.)
  app.get("/api/workspace-settings", async (req) =>
    workspaceGetSettings.run({}, await ctx(req)),
  );
  app.put("/api/workspace-settings", async (req) =>
    workspaceUpdateSettings.run(req.body, await ctx(req)),
  );

  // License status (T8.2) — surfaces the verdict persisted by the worker
  app.get("/api/license", async (req) => licenseStatusGet.run({}, await ctx(req)));
}
